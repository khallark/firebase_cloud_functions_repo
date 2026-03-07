// couriers/bluedart/returnPayloadBuilder.ts

import { normalizePhoneNumber } from "../../helpers";

interface BlueDartReturnShipmentParams {
  orderId: string;
  order: any;
  customerCode: string;
  loginId: string;
  licenceKey: string;
}

/**
 * Builds Blue Dart reverse/return shipment payload.
 *
 * Key differences vs the forward payload:
 *  - Consignee  ← warehouse (return destination)
 *  - Shipper    ← customer  (pickup origin)
 *  - Returnadds ← warehouse (RTO fallback, same as Consignee)
 *  - IsReversePickup: true
 *  - RegisterPickup:  true
 *  - SubProductCode:  always "P" (prepaid – no COD on returns)
 *  - Item list filtered by order.returnItemsVariantIds when present
 */
export function buildBlueDartReturnPayload(params: BlueDartReturnShipmentParams) {
  const { order, customerCode, loginId, licenceKey } = params;
  console.log(order?.bdDestinationArea || "");

  // ── Customer address (pickup origin for return) ───────────────────────────
  const customerAddr =
    order?.raw?.shipping_address ||
    order?.raw?.billing_address ||
    order?.raw?.default_address ||
    {};

  // ── Item selection (mirrors Delhivery return logic) ───────────────────────
  const lineItems: any[] = Array.isArray(order?.raw?.line_items) ? order.raw.line_items : [];

  let selected: any[];
  if (Array.isArray(order?.returnItemsVariantIds) && order.returnItemsVariantIds.length > 0) {
    const variantIdSet = new Set(order.returnItemsVariantIds.map((x: any) => String(x)));
    selected = lineItems.filter((li) => variantIdSet.has(String(li.variant_id)));
    if (selected.length === 0) {
      throw new Error("NO_ITEMS_MATCH_RETURN_VARIANT_IDS");
    }
  } else {
    selected = lineItems;
    if (selected.length === 0) {
      throw new Error("NO_LINE_ITEMS_IN_ORDER");
    }
  }

  // ── Build itemdtl for selected items ──────────────────────────────────────
  const itemdtl = selected.map((item: any, index: number) => {
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

    const pricePerUnit = Number(item.price || 0);
    const qty = Number(item.quantity || 1);

    const lineItemDiscount =
      Array.isArray(item.discount_allocations) && item.discount_allocations.length > 0
        ? item.discount_allocations.reduce(
            (total: number, discount: any) => total + Number(discount.amount || 0),
            0,
          )
        : 0;

    const lineTotal = pricePerUnit * qty;
    const taxableAmount = lineTotal - lineItemDiscount;
    const itemValueAfterDiscount = qty > 0 ? taxableAmount / qty : pricePerUnit;

    return {
      HSCode: "61091000",
      Instruction: "",
      InvoiceDate: `/Date(${Date.now()})/`,
      InvoiceNumber: `INV-${order.name || String(order.id)}-${index + 1}`,
      ItemID: String(item.id || index),
      ItemName: item.name || item.title || "Item",
      ItemValue: itemValueAfterDiscount,
      Itemquantity: qty,
      PlaceofSupply:
        customerAddr?.province_code || order?.raw?.billing_address?.province_code || "",
      ProductDesc1: "",
      ProductDesc2: "",
      ReturnReason: "",
      CGSTAmount,
      IGSTAmount,
      SGSTAmount,
      SKUNumber: item.sku || "",
      SellerGSTNNumber: "03AAQCM9385B1Z8",
      SellerName: "MAJIME TECHNOLOGIES PRIVATE LIMITED",
      SubProduct1: "",
      SubProduct2: "",
      TaxableAmount: taxableAmount,
      TotalValue: taxableAmount + CGSTAmount + SGSTAmount + IGSTAmount,
      cessAmount: "0.0",
      countryOfOrigin: "",
      docType: "",
      subSupplyType: 1,
      supplyType: "",
    };
  });

  const subtotalPrice = Number(order.raw?.subtotal_price || 0);
  const commodityDetail2 = selected[0]?.title || "Product";

  // ── Warehouse / company constants ─────────────────────────────────────────
  const warehouseAddress1 = "Village Husainpura, Hadbast 99";
  const warehouseAddress2 = "Near Paras Estate";
  const warehouseAddress3 = "Ludhiana, Punjab";
  const warehousePincode = "141008";
  const warehouseMobile = "9132326000";
  const warehouseGST = "03AAQCM9385B1Z8";
  const warehouseName = "MAJIME TECHNOLOGIES PRIVATE LIMITED";

  const payload = {
    Request: {
      // ── Consignee = WAREHOUSE (return destination) ──────────────────────
      Consignee: {
        AvailableDays: "",
        AvailableTiming: "",
        ConsigneeAddress1: warehouseAddress1,
        ConsigneeAddress2: warehouseAddress2,
        ConsigneeAddress3: warehouseAddress3,
        ConsigneeAddressType: "",
        ConsigneeAddressinfo: "",
        ConsigneeAttention: warehouseName,
        ConsigneeEmailID: "",
        ConsigneeFullAddress: [
          warehouseAddress1,
          warehouseAddress2,
          warehouseAddress3,
          warehousePincode,
        ].join(", "),
        ConsigneeGSTNumber: warehouseGST,
        ConsigneeLatitude: "",
        ConsigneeLongitude: "",
        ConsigneeMaskedContactNumber: "",
        ConsigneeMobile: warehouseMobile,
        ConsigneeName: warehouseName,
        ConsigneePincode: warehousePincode,
        ConsigneeTelephone: "",
      },

      // ── Returnadds = warehouse fallback RTO address ─────────────────────
      Returnadds: {
        ManifestNumber: "",
        ReturnAddress1: warehouseAddress1,
        ReturnAddress2: warehouseAddress2,
        ReturnAddress3: warehouseAddress3,
        ReturnAddressinfo: "",
        ReturnContact: "SHUBHDEEP ARORA",
        ReturnEmailID: "",
        ReturnLatitude: "",
        ReturnLongitude: "",
        ReturnMaskedContactNumber: "",
        ReturnMobile: warehouseMobile,
        ReturnPincode: warehousePincode,
        ReturnTelephone: "",
      },

      // ── Services ────────────────────────────────────────────────────────
      Services: {
        ActualWeight: "0.25",
        CollectableAmount: 0, // Never COD on a return
        Commodity: {
          CommodityDetail1: "Apparel",
          CommodityDetail2: commodityDetail2,
          CommodityDetail3: "",
        },
        CreditReferenceNo: order.name || String(order.id),
        CreditReferenceNo2: "",
        CreditReferenceNo3: "",
        DeclaredValue: subtotalPrice,
        DeliveryTimeSlot: "",
        Dimensions: [
          {
            Length: 10,
            Breadth: 10,
            Height: 10,
            Count: 1,
          },
        ],
        FavouringName: "",
        IsDedicatedDeliveryNetwork: false,
        IsDutyTaxPaidByShipper: false,
        IsForcePickup: false,
        IsPartialPickup: false,
        IsReversePickup: true, // ← key flag for return
        ItemCount: selected.length,
        Officecutofftime: "",
        PDFOutputNotRequired: true,
        PackType: "",
        ParcelShopCode: "",
        PayableAt: "",
        PickupDate: `/Date(${Date.now()})/`,
        PickupMode: "",
        PickupTime: "1600",
        PickupType: "",
        PieceCount: "1",
        PreferredPickupTimeSlot: "",
        ProductCode: "A",
        ProductFeature: "",
        ProductType: 1,
        RegisterPickup: true, // ← required for reverse pickup scheduling
        SpecialInstruction: "",
        SubProductCode: "P", // ← always Prepaid for returns
        TotalCashPaytoCustomer: 0,
        itemdtl,
        noOfDCGiven: 0,
      },

      // ── Shipper = CUSTOMER (pickup origin for return) ────────────────────
      Shipper: {
        CustomerAddress1: customerAddr?.address1 || "",
        CustomerAddress2: customerAddr?.address2 || "",
        CustomerAddress3: customerAddr?.city || customerAddr?.company || "",
        CustomerAddressinfo: "",
        CustomerBusinessPartyTypeCode: "",
        CustomerCode: customerCode,
        CustomerEmailID: order?.email || order?.raw?.customer?.email || "",
        CustomerGSTNumber: "",
        CustomerLatitude: "",
        CustomerLongitude: "",
        CustomerMaskedContactNumber: "",
        CustomerMobile: normalizePhoneNumber(
          order?.raw?.customer?.phone ||
            customerAddr?.phone ||
            order?.raw?.billing_address?.phone ||
            "",
        ),
        CustomerName:
          customerAddr?.name || order?.raw?.customer?.first_name
            ? [order?.raw?.customer?.first_name, order?.raw?.customer?.last_name]
                .filter(Boolean)
                .join(" ")
            : "Customer",
        CustomerPincode: customerAddr?.zip || "",
        CustomerTelephone: "",
        IsToPayCustomer: true,
        OriginArea: "LDH",
        Sender: customerAddr?.name || "Customer",
        VendorCode: "",
      },
    },

    Profile: {
      LoginID: loginId,
      LicenceKey: licenceKey,
      Api_type: "S",
    },
  };

  return payload;
}
