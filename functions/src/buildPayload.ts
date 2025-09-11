// functions/src/buildPayload.ts
/** Map your order doc → carrier payload (Delhivery example). */
export function buildDelhiveryPayload(params: {
  orderId: string;
  awb: string;
  order: any;
}) {
  const { orderId, awb, order } = params;
  const ship = order?.raw?.shipping_address || {};
  const paid = (order?.financialStatus || "").toLowerCase() === "paid";

  return {
    shipments: [{
      waybill: awb,
      order: orderId,
      consignee: {
        name: order?.name || ship?.name || "Customer",
        phone: order?.phone || ship?.phone || "",
        address: ship?.address1 || "",
        address2: ship?.address2 || "",
        city: ship?.city || "",
        state: ship?.province || "",
        pincode: ship?.zip || "",
      },
      payment_mode: paid ? "Prepaid" : "COD",
      // add weight, product details, invoice, etc. as required by your account
    }]
  };
}
