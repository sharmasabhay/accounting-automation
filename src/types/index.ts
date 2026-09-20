export interface FieldWithConfidence<T = string> {
  value: T;
  confidence: number;
}

export interface LineItemExtraction {
  name: FieldWithConfidence;
  quantity: FieldWithConfidence<number>;
  unitAmount: FieldWithConfidence<number>;
}

export interface InvoiceExtraction {
  supplier: FieldWithConfidence;
  invoiceNumber: FieldWithConfidence;
  invoiceDate: FieldWithConfidence;
  lineItems: LineItemExtraction[];
  total: FieldWithConfidence<number>;
  signedOrStamped?: boolean;
  poNumber?: FieldWithConfidence;
}

export interface ParsedOrderItem {
  itemName: string;
  quantity: number;
  unit?: string;
  supplier?: string;
  xeroItemId?: string;
  xeroItemCode?: string;
  unitPrice?: number;
  priceSource?: "history" | "confirmed" | "unknown";
}

export interface ParsePurchaseOrderResult {
  isPurchaseOrder: boolean;
  items: ParsedOrderItem[];
  reason?: string;
  supplierName?: string;
}

export interface PayableListItem {
  invoiceNumber: string;
  amount: number;
  xeroBillId: string;
}

export interface PayableList {
  supplierId: string;
  supplierName: string;
  period: string;
  items: PayableListItem[];
  totalAmount: number;
  referenceText: string;
}

export interface SoaInvoiceLine {
  invoiceNumber: string;
  amount: number;
}

export interface SoaExtraction {
  invoices: SoaInvoiceLine[];
  balanceDue: number;
  periodLabel?: string;
}

export interface SoaCompareBucketItem {
  invoiceNumber: string;
  amount: number;
  xeroBillId?: string;
}

export interface SoaCompareResult {
  matched: SoaCompareBucketItem[];
  missingFromXero: SoaCompareBucketItem[];
  amountMismatch: Array<{
    invoiceNumber: string;
    soaAmount: number;
    xeroAmount: number;
    xeroBillId?: string;
  }>;
  xeroAbsentFromSoa: SoaCompareBucketItem[];
}

export interface XeroItem {
  itemId: string;
  code: string;
  name: string;
}

export interface XeroOpenPurchaseOrder {
  xeroPoId: string;
  xeroPoNumber: string;
  date: string;
  status: string;
  total: number;
  lineItems: Array<{
    description: string;
    itemCode?: string;
    quantity: number;
    unitAmount: number;
  }>;
}

export interface XeroBillRecord {
  xeroBillId: string;
  invoiceNumber: string;
  invoiceDate: string;
  total: number;
  status: string;
}

export interface WhatsAppInboundMessage {
  messageId: string;
  from: string;
  timestamp: string;
  type: "text" | "image" | "document";
  text?: string;
  mediaId?: string;
  mimeType?: string;
  filename?: string;
  isGroup: boolean;
  groupId?: string;
  mentionsBot?: boolean;
  organizationId?: string;
  whatsappPhoneNumberId?: string;
  /** WABA id from webhook entry.id — identifies the tenant's WhatsApp Business Account */
  whatsappBusinessAccountId?: string;
}

export interface SavedEmailAttachment {
  filePath: string;
  filename: string;
  contentType: string;
  from: string;
  subject: string;
  messageId: string;
  kind: "invoice" | "soa";
}

export interface InvoiceCaptureJobPayload {
  organizationId: string;
  workflowRunId: string;
  filePath: string;
  source: "EMAIL" | "WHATSAPP";
  sourceRef: string;
  notifyPhone: string;
  mimeType?: string;
}

export type WorkflowEvent =
  | { type: "whatsapp.message"; payload: WhatsAppInboundMessage }
  | {
      type: "email.scan";
      payload: { scheduledAt: string; organizationId: string; attachments?: SavedEmailAttachment[] };
    }
  | { type: "invoice.capture"; payload: InvoiceCaptureJobPayload }
  | { type: "approval.resolved"; payload: { approvalId: string; response: string; organizationId: string } }
  | { type: "reconciliation.payable.ready"; payload: { reconciliationRunId: string; organizationId: string } }
  | { type: "payment.monitor"; payload: { scheduledAt: string; organizationId: string } }
  | { type: "follow-up"; payload: { taskId: string; organizationId: string } };
