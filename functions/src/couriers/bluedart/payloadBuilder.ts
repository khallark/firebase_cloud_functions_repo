// couriers/bluedart/payloadBuilder.ts

import { normalizePhoneNumber } from "../../helpers";

interface BlueDartShipmentParams {
  orderId?: string;
  order: any;
  pickupName: string;
  customerCode: string;
  loginId: string;
  licenceKey: string;
}

/**
 * Builds Blue Dart shipment creation payload from order data
 * Maps order document to Blue Dart's complex nested schema
 */
export function buildBlueDartPayload(params: BlueDartShipmentParams) {
  const { order, customerCode, loginId, licenceKey } = params;

  const ship =
    order?.raw?.shipping_address ||
    order?.raw?.billing_address ||
    order?.raw?.default_address ||
    {};

  const billing = order?.raw?.billing_address || ship;
  
  const items =
    (Array.isArray(order?.raw?.line_items) && order.raw.line_items) || order?.lineItems || [];

  // Calculate GST amounts and build item details
  const itemdtl = items.map((item: any, index: number) => {
    let CGSTAmount = 0;
    let SGSTAmount = 0;
    let IGSTAmount = 0;

    if (Array.isArray(item.tax_lines)) {
      for (const tax of item.tax_lines) {
        if (tax.title === "CGST") CGSTAmount += Number(tax.price || 0);
        if (tax.title === "SGST") SGSTAmount += Number(tax.price || 0);
        if (tax.title === "IGST") IGSTAmount += Number(tax.price || 0);
      }
    }

    // Validate GST split
    if (IGSTAmount > 0 && (CGSTAmount > 0 || SGSTAmount > 0)) {
      console.warn(`Invalid GST split for item ${item.id}: IGST + CGST/SGST together`);
    }

    const price = Number(item.price || 0);
    const qty = Number(item.quantity || 1);
    const taxableAmount = price * qty;

    return {
      HSCode: "61091000", // Hardcoded - apparel HS code
      Instruction: "",
      InvoiceDate: `/Date(${Date.now()})/`,
      InvoiceNumber: `INV-${order.name || String(order.id)}-${index + 1}`,
      ItemID: String(item.id || index),
      ItemName: item.title || item.name || "Item",
      ItemValue: price,
      Itemquantity: qty,
      PlaceofSupply: ship?.province_code || billing?.province_code || "",
      ProductDesc1: "",
      ProductDesc2: "",
      ReturnReason: "",
      CGSTAmount: CGSTAmount,
      IGSTAmount: IGSTAmount,
      SGSTAmount: SGSTAmount,
      SKUNumber: item.sku || "",
      SellerGSTNNumber: "<your_gstn>", // Hardcoded - to be replaced
      SellerName: "<my_legal_business_name>", // Hardcoded - to be replaced
      SubProduct1: "",
      SubProduct2: "",
      TaxableAmount: taxableAmount,
      TotalValue: taxableAmount + CGSTAmount + SGSTAmount + IGSTAmount,
      cessAmount: "0.0",
      countryOfOrigin: "",
      docType: "",
      subSupplyType: 1,
      supplyType: ""
    };
  });

  const totalOutstanding = Number(order.raw?.total_outstanding || 0);
  const subtotalPrice = Number(order.raw?.subtotal_price || 0);
  
  // Determine commodity details based on items
  const commodityDetail1 = "Apparel"; // Hardcoded for now
  const commodityDetail2 = items[0]?.title || "Product";

  const payload = {
    Request: {
      Consignee: {
        AvailableDays: "",
        AvailableTiming: "",
        ConsigneeAddress1: ship?.address1 || billing?.address1 || "",
        ConsigneeAddress2: ship?.address2 || billing?.address2 || "",
        ConsigneeAddress3: ship?.city || billing?.city || ship?.company || billing?.company || "",
        ConsigneeAddressType: "",
        ConsigneeAddressinfo: "",
        ConsigneeAttention: ship?.name || billing?.name || "Customer",
        ConsigneeEmailID: order.email || order.raw?.customer?.email || "noreply@yourdomain.com",
        ConsigneeFullAddress: [
          ship?.address1 || billing?.address1 || "-",
          ship?.zip || billing?.zip || "-",
          ship?.city || billing?.city || "-",
          ship?.province || billing?.province || "-",
          ship?.country || billing?.country || "-",
          ship?.address2 || billing?.address2 || "-",
          ship?.zip || billing?.zip || "-",
          ship?.city || billing?.city || "-",
          ship?.province || billing?.province || "-",
          ship?.country || billing?.country || "-"
        ].join(", "),
        ConsigneeGSTNumber: "",
        ConsigneeLatitude: "",
        ConsigneeLongitude: "",
        ConsigneeMaskedContactNumber: "",
        ConsigneeMobile: normalizePhoneNumber(
          order.raw?.customer?.phone ||
          ship?.phone ||
          billing?.phone ||
          ""
        ),
        ConsigneeName: ship?.name || billing?.name || "Customer",
        ConsigneePincode: ship?.zip || billing?.zip || "",
        ConsigneeTelephone: ""
      },
      Returnadds: {
        ManifestNumber: "",
        ReturnAddress1: "Test RTO Addr1", // Hardcoded - to be replaced
        ReturnAddress2: "Test RTO Addr2", // Hardcoded - to be replaced
        ReturnAddress3: "Test RTO Addr3", // Hardcoded - to be replaced
        ReturnAddressinfo: "",
        ReturnContact: "Test RTO", // Hardcoded - to be replaced
        ReturnEmailID: "testemail@bluedart.com", // Hardcoded - to be replaced
        ReturnLatitude: "",
        ReturnLongitude: "",
        ReturnMaskedContactNumber: "",
        ReturnMobile: "  ", // Hardcoded - to be replaced
        ReturnPincode: "141008", // Hardcoded - to be replaced
        ReturnTelephone: ""
      },
      Services: {
        ActualWeight: "0.25", // Hardcoded
        CollectableAmount: totalOutstanding,
        Commodity: {
          CommodityDetail1: commodityDetail1,
          CommodityDetail2: commodityDetail2,
          CommodityDetail3: ""
        },
        CreditReferenceNo: order.name || String(order.id),
        CreditReferenceNo2: "",
        CreditReferenceNo3: "",
        DeclaredValue: subtotalPrice,
        DeliveryTimeSlot: "",
        Dimensions: [
          {
            Length: 10, // Hardcoded
            Breadth: 10, // Hardcoded
            Height: 10, // Hardcoded
            Count: 1 // Hardcoded
          }
        ],
        FavouringName: "",
        IsDedicatedDeliveryNetwork: false,
        IsDutyTaxPaidByShipper: false,
        IsForcePickup: false,
        IsPartialPickup: false,
        IsReversePickup: false,
        ItemCount: items.length,
        Officecutofftime: "",
        PDFOutputNotRequired: true,
        PackType: "",
        ParcelShopCode: "",
        PayableAt: "",
        PickupDate: `/Date(${Date.now()})/`,
        PickupMode: "",
        PickupTime: "1600", // Hardcoded
        PickupType: "",
        PieceCount: "1", // Hardcoded
        PreferredPickupTimeSlot: "",
        ProductCode: "A", // Hardcoded
        ProductFeature: "",
        ProductType: 1,
        RegisterPickup: true,
        SpecialInstruction: "",
        SubProductCode: totalOutstanding > 0 ? "C" : "P", // C = COD, P = Prepaid
        TotalCashPaytoCustomer: 0,
        itemdtl: itemdtl,
        noOfDCGiven: 0
      },
      Shipper: {
        CustomerAddress1: "Test Cust Addr1", // Hardcoded - to be replaced
        CustomerAddress2: "Test Cust Addr2", // Hardcoded - to be replaced
        CustomerAddress3: "Test Cust Addr3", // Hardcoded - to be replaced
        CustomerAddressinfo: "",
        CustomerBusinessPartyTypeCode: "",
        CustomerCode: customerCode,
        CustomerEmailID: "TestCustEmail@bd.com", // Hardcoded - to be replaced
        CustomerGSTNumber: "",
        CustomerLatitude: "",
        CustomerLongitude: "",
        CustomerMaskedContactNumber: "",
        CustomerMobile: "9996665554", // Hardcoded - to be replaced
        CustomerName: "Test Cust Name", // Hardcoded - to be replaced
        CustomerPincode: "141008", // Hardcoded - to be replaced
        CustomerTelephone: "",
        IsToPayCustomer: true,
        OriginArea: "LDH", // Hardcoded - to be replaced
        Sender: "TestRvp", // Hardcoded - to be replaced
        VendorCode: ""
      }
    },
    Profile: {
      LoginID: loginId,
      LicenceKey: licenceKey,
      Api_type: "S"
    }
  };

  return payload;
}