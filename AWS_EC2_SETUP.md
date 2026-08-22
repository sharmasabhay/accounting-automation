# Step-by-step: accounting.omakase.pet (new EC2 + ALB)

**Correction:** `sg.omakase.pet` is **not** behind an ALB. It points at that instance’s **public DNS**, with Let’s Encrypt on the box.

Leave **sg** exactly as it is. This guide only adds a **new** hostname on a **new** instance behind the ALB.

```
sg.omakase.pet          →  existing EC2 public DNS  (Let’s Encrypt on that instance)
accounting.omakase.pet  →  ALB (HTTPS / ACM)  →  new EC2 :3000
```

Do **not** install Certbot on the new instance. Do **not** change sg DNS or Nginx.

---

## Before you start

Same **region** as the sg instance (example: `ap-southeast-1`). Note:

1. **VPC ID** of the sg instance  
2. **At least two public subnets in different AZs** in that VPC (ALB requires this)  
3. **Key pair** for SSH  
4. Access to DNS for `omakase.pet` (Route 53 or your registrar)

`sg.omakase.pet` stays on the old instance public DNS. You will **create a new ALB** for accounting only.

---

## Step 1 — Request an ACM certificate (for the ALB)

Let’s Encrypt on sg is **not** used here. The ALB needs an **ACM** certificate in the **same region** as the load balancer.

1. Open **AWS Certificate Manager** (not the EC2 instance).  
2. Confirm the region in the top-right matches your VPC.  
3. **Request certificate** → **Request a public certificate** → Next.  
4. Fully qualified domain names — add:
   - `accounting.omakase.pet`  
   - Optional but useful: `*.omakase.pet`  
5. Validation method: **DNS validation**.  
6. Key algorithm: RSA 2048 (default) → **Request**.  
7. Open the new certificate. Status will be **Pending validation**.  
8. Expand the domain → copy the **CNAME name** and **CNAME value**.  
9. In your DNS (Route 53 hosted zone `omakase.pet`, or the registrar):
   - Create a **CNAME** with those two values **exactly** (do not change the sg A/CNAME record).  
10. Wait until ACM status is **Issued** (often 2–30 minutes). Do not create the ALB HTTPS listener until it is Issued.

If you already have an **Issued** ACM cert for `*.omakase.pet` in this region, skip this step and use that cert.

---

## Step 2 — Security group for the ALB

**EC2 → Security Groups → Create security group**

| Field | Value |
|-------|--------|
| Name | `omakase-accounting-alb` |
| Description | Internet → ALB for accounting.omakase.pet |
| VPC | Same as the sg instance |

**Inbound**

| Type | Port | Source |
|------|------|--------|
| HTTP | 80 | `0.0.0.0/0` |
| HTTPS | 443 | `0.0.0.0/0` |

**Outbound:** default (All traffic / `0.0.0.0/0`).

Create. Copy the group ID (`sg-…`). You need it in Step 3.

---

## Step 3 — Security group for the **new** EC2 instance

**EC2 → Security Groups → Create security group**

| Field | Value |
|-------|--------|
| Name | `omakase-accounting-ec2` |
| VPC | Same VPC |

**Inbound**

| Type | Port | Source |
|------|------|--------|
| SSH | 22 | My IP |
| Custom TCP | **3000** | **Custom** → select `omakase-accounting-alb` |

**Outbound:** default.

Do **not** open 80/443 on this instance. Do **not** edit the sg instance security group.

---

## Step 4 — Launch the **new** EC2 instance

**EC2 → Instances → Launch instance**

| Field | Value |
|-------|--------|
| Name | `omakase-accounting` |
| AMI | Ubuntu Server 22.04 or 24.04 LTS |
| Type | `t3.small` or larger |
| Key pair | Existing or new |
| VPC | Same as above |
| Subnet | A subnet in that VPC (public if you SSH from the internet) |
| Auto-assign public IP | Enable if you SSH without a bastion |
| Security group | `omakase-accounting-ec2` |
| Storage | 30 GB gp3 |

Launch. Wait for **Running** and **2/2 status checks**. Note the instance ID.

---

## Step 5 — Target group

Create this **before** the ALB so you can select it on the listener.

**EC2 → Target Groups → Create target group**

**Basic config**

| Field | Value |
|-------|--------|
| Target type | **Instances** |
| Name | `omakase-accounting` |
| Protocol | **HTTP** |
| Port | **3000** |
| IP address type | IPv4 |
| VPC | Same VPC |

**Health checks**

| Field | Value |
|-------|--------|
| Protocol | HTTP |
| Path | `/health` |
| Port | Traffic port |
| Healthy threshold | 2 |
| Unhealthy threshold | 3 |
| Timeout | 5 |
| Interval | 30 |
| Success codes | **200** |

**Next** → available instances → tick **omakase-accounting** → port **3000** → **Include as pending below** → **Create target group**.

The target stays **unhealthy** until the Node app is listening. That is expected.

---

## Step 6 — Create the Application Load Balancer

**EC2 → Load Balancers → Create load balancer → Application Load Balancer → Create**

### 6.1 Basic configuration

| Field | Value |
|-------|--------|
| Name | `omakase-accounting-alb` |
| Scheme | **Internet-facing** |
| IP address type | IPv4 |

### 6.2 Network mapping

| Field | Value |
|-------|--------|
| VPC | Same VPC as the instance |
| Mappings | Select **at least two Availability Zones** |

For each AZ, choose a **public subnet** (one that has a route to an Internet Gateway). The ALB will fail to be reachable if you pick only private subnets.

### 6.3 Security groups

- Remove the default if it is too open or wrong VPC.  
- Select **`omakase-accounting-alb` only**.

### 6.4 Listeners and routing

You need **two** listeners.

**Listener 1 — HTTP (redirect to HTTPS)**

| Field | Value |
|-------|--------|
| Protocol | HTTP |
| Port | 80 |
| Default action | **Redirect to URL** |
| Protocol | HTTPS |
| Port | 443 |
| Status code | `301` |

If the wizard only lets you add a forward action at first:

1. Set HTTP:80 default to a temporary forward to `omakase-accounting`.  
2. After the ALB is created, edit the HTTP:80 listener → change default action to **Redirect to HTTPS:443**.

**Listener 2 — HTTPS**

Click **Add listener**.

| Field | Value |
|-------|--------|
| Protocol | HTTPS |
| Port | 443 |
| Default action | **Forward to** target group `omakase-accounting` |
| Secure listener settings → Certificate source | **From ACM** |
| Certificate | The **Issued** cert from Step 1 (`accounting.omakase.pet` or `*.omakase.pet`) |

Leave SSL policy as the AWS default (or `ELBSecurityPolicy-TLS13-1-2-2021-06`).

Optional: **Add listener rule** on HTTPS:443:

- Condition: **Host header** is `accounting.omakase.pet`  
- Action: Forward to `omakase-accounting`  

Not required if this ALB is used only for this hostname (the default forward is enough).

### 6.5 Create

Click **Create load balancer**. Wait until **State = Active**.

Open the ALB → copy **DNS name** (looks like `omakase-accounting-alb-xxxxxxxxx.ap-southeast-1.elb.amazonaws.com`). You need it for DNS.

---

## Step 7 — DNS for **accounting only**

Do **not** change the `sg.omakase.pet` record.

### Route 53

1. **Route 53 → Hosted zones → omakase.pet → Create record**  
2. Fill:

| Field | Value |
|-------|--------|
| Record name | `accounting` |
| Record type | **A** |
| Alias | **Yes** |
| Route traffic to | **Alias to Application and Classic Load Balancer** |
| Region | Same region as the ALB |
| Load balancer | `omakase-accounting-alb` (the one from Step 6) |
| Evaluate target health | No (optional) |

**Create records.**

### DNS not in Route 53

Create a **CNAME**:

```
Name:  accounting.omakase.pet
Value: omakase-accounting-alb-xxxxxxxxx.ap-southeast-1.elb.amazonaws.com
```

Use the exact ALB DNS name from Step 6. Do **not** use `http://` or a trailing path.

Wait a few minutes, then:

```bash
dig accounting.omakase.pet
dig sg.omakase.pet
```

- `accounting` → ALB  
- `sg` → old instance public DNS (unchanged)

---

## Step 7 — SSH into the **new** instance

```bash
ssh -i /path/to/key.pem ubuntu@<new-instance-public-ip>
```

---

## Step 8 — Install Node, Docker, PM2

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
sudo apt install -y docker-compose-plugin
sudo npm install -g pm2
```

Log out and SSH back in. Confirm `docker ps` works.

**Do not install nginx or certbot** on this instance.

---

## Step 9 — Copy the app

On the server:

```bash
sudo mkdir -p /var/www
sudo chown ubuntu:ubuntu /var/www
```

From your laptop:

```bash
rsync -avz --exclude node_modules --exclude dist --exclude .env \
  -e "ssh -i /path/to/key.pem" \
  /var/www/html/omakase_accounting/ \
  ubuntu@<new-instance-ip>:/var/www/omakase_accounting/
```

Or `git clone` into `/var/www/omakase_accounting`.

---

## Step 10 — Database, `.env`, build

```bash
cd /var/www/omakase_accounting
npm install
docker compose up -d
docker compose ps
cp .env.example .env
openssl rand -hex 24
nano .env
chmod 600 .env
```

Required `.env` values:

```env
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
API_TOKEN=<openssl-output>
DRY_RUN=true
LOG_LEVEL=info
TIMEZONE=Asia/Singapore

DATABASE_URL=postgresql://omakase:omakase_secret@127.0.0.1:5432/omakase_accounting?schema=public
REDIS_URL=redis://127.0.0.1:6379

PUBLIC_BASE_URL=https://accounting.omakase.pet
XERO_REDIRECT_URI=https://accounting.omakase.pet/auth/xero/callback

WHATSAPP_VERIFY_TOKEN=<random>
ANTHROPIC_API_KEY=<your-key>
OCR_PROVIDER=claude
```

`HOST` **must** be `0.0.0.0` or ALB health checks fail.

```bash
npx prisma generate
npx prisma db push
npm run db:seed
npm run build
ls dist/index.js dist/jobs/worker.js
```

---

## Step 11 — Start the app

```bash
cd /var/www/omakase_accounting
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Run the `sudo` line `pm2 startup` prints.

```bash
pm2 status
curl -s http://127.0.0.1:3000/health
```

Target group should become **healthy**.

---

## Step 12 — Test

```bash
curl -s https://accounting.omakase.pet/health
```

Browser: https://accounting.omakase.pet/admin  
Also confirm https://sg.omakase.pet still works (unchanged).

---

## Step 13 — WhatsApp and Xero

- WhatsApp webhook: `https://accounting.omakase.pet/webhooks/whatsapp`  
- Xero redirect: `https://accounting.omakase.pet/auth/xero/callback`  

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| ACM stuck **Pending validation** | CNAME from ACM must exist in DNS; wait; check you are in the **same region** as the ALB |
| Cannot select certificate on HTTPS listener | Cert not **Issued**, or ACM is in a **different region** |
| ALB created but site times out | ALB scheme must be **internet-facing**; subnets must be **public** (IGW route); ALB SG must allow 80/443 from the internet |
| Target unhealthy | App down, `HOST=127.0.0.1`, or instance SG missing **3000 from ALB SG** |
| SSL name mismatch | ACM cert does not include `accounting.omakase.pet` or `*.omakase.pet` |
| 502 | Wrong target group or still unhealthy |
| HTTP works, HTTPS fails | HTTPS:443 listener missing, or wrong / expired ACM cert |
| `sg` broke | You changed sg DNS — revert it to the **old instance public DNS** |
| Jobs stuck | `pm2 logs omakase-worker` |

Keep `DRY_RUN=true` until a practice run succeeds.
