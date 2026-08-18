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
}

export interface ParsedOrderItem {
  itemName: string;
  quantity: number;
  unit?: string;
}

export interface ParsePurchaseOrderResult {
  isPurchaseOrder: boolean;
  items: ParsedOrderItem[];
  reason?: string;
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

export type WorkflowEvent =
  | { type: "whatsapp.message"; payload: WhatsAppInboundMessage }
  | { type: "email.scan"; payload: { scheduledAt: string; organizationId: string } }
  | { type: "approval.resolved"; payload: { approvalId: string; response: string; organizationId: string } }
  | { type: "reconciliation.payable.ready"; payload: { reconciliationRunId: string; organizationId: string } }
  | { type: "payment.monitor"; payload: { scheduledAt: string; organizationId: string } };
