# Majime Platform — Complete Route Map

All frontend routes are prefixed with `/business/{businessId}`.
All authenticated API routes are prefixed with `/api`.

---

## PLATFORM CONCEPTS (read this first)

### Two Types of Stores
- **Own stores** — Shopify stores belonging only to this business. Data lives at `accounts/{storeId}/`. No vendor filtering applied.
- **Shared stores** — Shopify stores shared across multiple businesses (e.g. a multi-vendor Majime marketplace). Orders carry a `vendors` array (e.g. `['ENDORA', 'STYLE 05']`). Non-admin businesses only see orders whose `vendors` array contains their `vendorName` claim. Certain statuses (New, DTO Requested, Pending Refunds) are hidden from vendors on shared stores. Order splitting is triggered when a shared-store order contains items from more than one vendor.

### Order Status Lifecycle
```
New ─────────────────────────── Cancellation Requested → Cancelled
 └─ Confirmed ─────────────────────────── Cancelled
     └─ [UPCs assigned, pickupReady=true] → Ready To Dispatch
         └─ Dispatched
             ├─ In Transit
             │   └─ Out For Delivery
             │       └─ Delivered
             │           ├─ Closed
             │           └─ DTO Requested → DTO Booked → DTO In Transit
             │                                               └─ DTO Delivered → Pending Refunds → DTO Refunded
             └─ RTO In Transit → RTO Delivered → RTO Closed
                                              └─ Lost
```

**Status reversal paths:**
- Ready To Dispatch → back to Confirmed (revert-to-confirmed: clears awb, courier, courierProvider fields, trims status log to Confirmed entry)
- DTO Requested / DTO Booked → back to Delivered (revert-to-delivered: clears awb_reverse, courier_reverse, courierReverseProvider, trims log to Delivered entry)

**Status timestamp fields (`{status}At`, `lastStatusUpdate`):**
No API route writes these fields directly. They are maintained exclusively by the `updateOrderCounts` Firestore trigger, which reads the order's `customStatusesLogs` array on every status change, sets `{toCamelCase(status)}At` from the latest valid log entry's `createdAt`, sets `lastStatusUpdate` to the same value, and deletes any stale `{status}At` fields not backed by a log entry.

### Business Product → Shopify Variant Mapping
One business product (`users/{businessId}/products/{sku}`) can be mapped to many Shopify store variants across all linked stores. Each store variant can only be mapped to one business product. The mapping is stored in two places simultaneously for bidirectional lookup:
- On the **store product** (`accounts/{storeId}/products/{productId}`): `variantMappings[variantId] = businessProductSku`, `variantMappingDetails[variantId] = {businessProductSku, businessId, mappedAt, mappedBy}`, `variantMappingsArray` (array for Firestore queries)
- On the **business product**: `mappedVariants` array of `{storeId, productId, productTitle, variantId, variantTitle, variantSku, mappedAt}`

This mapping drives: inventory blocking, automatic Shopify inventory sync, UPC assignment during pickup, and availability checks on Confirmed orders.

### UPC System
Every physical unit of a business product gets a unique UPC document (`users/{businessId}/upcs/{upcId}`). UPCs flow through these `putAway` states:
- `'inbound'` — received in warehouse (from GRN completion, RTO closed, or DTO QC pass), awaiting shelf placement
- `'none'` — placed at a shelf location (warehouseId/zoneId/rackId/shelfId/placementId populated)
- `'outbound'` — picked up for a specific order (storeId + orderId set, visible in Put Away → Outbound)
- dispatched — after order dispatch (orderId still set, visible in Put Away → Dispatched)

RTO/DTO returns push UPCs back to `'inbound'`. Placement ID is `{productId}_{shelfId}`.

### AWB Pool
AWBs (Air Waybill numbers) are fetched in bulk from Delhivery and stored at business level (`users/{businessId}/unused_awbs/{awb}` docs). Allocated via Firestore transaction (pop first doc, delete it). Released back on carrier API failure. Business-level pool is shared across all stores.

### Firestore Data Paths
- Business (user) doc: `users/{businessId}`
- Orders: `accounts/{storeId}/orders/{orderId}`
- Store products: `accounts/{storeId}/products/{productId}`
- Business products: `users/{businessId}/products/{sku}`
- UPCs: `users/{businessId}/upcs/{upcId}`
- Placements: `users/{businessId}/placements/{productId}_{shelfId}`
- Warehouses/Zones/Racks/Shelves: `users/{businessId}/warehouses|zones|racks|shelves/{code}`
- GRNs: `users/{businessId}/grns/{grnId}`
- Credit Notes: `users/{businessId}/credit_notes/{cnId}`
- Purchase Orders: `users/{businessId}/purchaseOrders/{poId}`
- Parties: `users/{businessId}/parties/{partyId}`
- Agent sessions: `users/{businessId}/agent_sessions/{sessionId}`
- Agent messages: `users/{businessId}/agent_sessions/{sessionId}/messages/{messageId}`
- B2B Orders: `users/{businessId}/orders/{orderId}`
- B2B Lots: `users/{businessId}/lots/{lotId}`
- B2B Products: `users/{businessId}/b2bProducts/{productId}`
- Raw Materials: `users/{businessId}/raw_materials/{materialId}`
- BOM: `users/{businessId}/bom/{bomId}`

---

## LAYOUT HIERARCHY & SHARED UI

The app uses a nested layout system. Understanding which layout wraps which page is critical for the agent.

```
app/business/layout.tsx                    ← Auth gate (Firebase auth check, redirect to /login)
  └─ app/business/[businessId]/layout.tsx  ← Business auth + Majime Agent chat panel (persists across ALL pages)
       ├─ app/business/[businessId]/dashboard/layout.tsx   ← Sidebar nav + ProcessingQueueProvider
       │    └─ dashboard pages (home, orders, reports, members)
       ├─ app/business/[businessId]/settings/layout.tsx    ← Settings sidebar nav
       │    └─ settings pages
       └─ app/business/[businessId]/warehouse/layout.tsx   ← Warehouse sidebar nav
            └─ warehouse pages
```

---

## LAYOUT FILES — DETAILED ANALYSIS

### `app/business/layout.tsx` — Firebase Auth Gate
**Wraps:** All `/business/*` routes

**What it does:**
- Uses `useAuthState(auth)` from `react-firebase-hooks`. While auth state is loading, shows a full-screen animated loading screen with a spinning ring and pulsing Building2 icon.
- If not authenticated after loading, redirects to `/login?redirect=/business`.
- If authenticated, renders `{children}` (the nested layouts).
- This layout exists purely as a security gate — it has no visible UI of its own once authenticated.

---

### `app/business/[businessId]/layout.tsx` — Business Auth + Majime Agent
**Wraps:** Every page under `/business/[businessId]/`

**This is the most important layout. It does two major things:**

#### 1. Business Authorization
- Calls `useBusinessAuthorization(businessId)` hook which hits `/api/business/[businessId]/auth`.
- Provides a `BusinessContext` (exported as `useBusinessContext()`) consumed by all child pages. The context carries: `isAuthorized`, `loading`, `user`, `stores`, `businessId`, `joinedBusinesses`, `vendorName`, `memberRole`.
- Shows `LoadingState` (animated spinner with "Loading Business" text) during auth check.
- Shows `NotAuthorizedState` (404 graphic with ShieldX icon, "Business Not Found" heading, Go Back + My Businesses buttons) if auth fails.
- Redirects from `/business/{businessId}` → `/business/{businessId}/dashboard/orders` once authorized.

#### 2. Majime Agent Chat Panel (persists across all pages via React portal)
This is the AI-powered in-app assistant. The entire agent UI is rendered into a portal appended to `document.documentElement` (not `document.body`) at a fixed z-index of 9999, so it floats above everything.

**Session Lifecycle (managed in this layout, not in the panel component):**
- Session state (`sessionId`, `sessionStatus`, `generatingStartedAt`, `messages`) lives in this layout so it survives page navigation.
- On first chat open: calls `POST /api/business/agent/session/create` → gets `sessionId`. Attaches two Firestore `onSnapshot` listeners:
  1. On `users/{businessId}/agent_sessions/{sessionId}` → drives `sessionStatus` ('idle'/'generating'/'error') and `generatingStartedAt`.
  2. On `users/{businessId}/agent_sessions/{sessionId}/messages` ordered by `createdAt` asc → drives the message list.
- Sending a message: `addDoc()` directly to the Firestore messages subcollection. The Cloud Function `onAgentMessageCreated` picks it up asynchronously and writes the reply.
- Session end: Called via `fetch('/api/business/agent/session/end', { keepalive: true })` on `beforeunload` (page close) and on layout unmount (client-side navigation away from the business).
- Firebase token is refreshed every 50 minutes to stay valid.

**Peek Button (`MajimeAgentPeekButton`):**
- Positioned fixed at the right edge, vertically centered.
- When mouse is more than 100px from right edge: peeking at 92% off-screen (only the "Majime Agent!" tab label visible).
- When mouse within 100px: slides to 33% off-screen (more of the tab visible).
- When hovered: slides fully into view (0% off-screen).
- Contains: "Ask the / Majime Agent!" label + Sparkles icon in a rounded button with primary color.
- Clicking opens the chat panel and triggers `initSession()` if not already started.
- Disappears (AnimatePresence exit) when chat panel is open.

**Chat Panel (`MajimeAgentChatPanel`):**
- Slides in from the right edge (spring animation, `width: clamp(320px, 550px, 100vw)`, `height: calc(100dvh - 1.5rem)`).
- **Header:** Sparkles icon + "Majime Assistant" title + "Your platform guide" subtitle. Status indicator dot (amber=starting, blue pulsing=generating/thinking, red=error, green pulsing=online). X button to hide panel (session stays alive).
- **Message area:** Scrollable. Shows welcome message until first real message arrives: *"Hi! I'm the Majime Assistant..."*. User messages as plain text bubbles (primary color, right-aligned). Assistant messages rendered with full `ReactMarkdown` + `remark-gfm` (bullet lists, bold, inline code, code blocks, links open in new tab). Loading dots animation (3 bouncing dots) shown when `sessionStatus === 'generating'`. Error banner shown if session errors or generating lock is stale (>30 seconds).
- **Session divider:** A thin line with "Session active" label between messages and input.
- **Input area:** Auto-growing textarea (min 42px, max 120px). Enter to send, Shift+Enter for newline. Send button with animated icon (RotateCcw spinning while sending, Send icon normally). Blocked when agent is generating (unless stale lock detected).
- **Stale lock detection:** If `sessionStatus === 'generating'` for >30 seconds (`STALE_GENERATING_MS`), the input unblocks and shows error banner — allows user to retry without waiting forever.

---

### `app/business/[businessId]/dashboard/layout.tsx` — Dashboard Sidebar
**Wraps:** All `/business/[businessId]/dashboard/*` routes

**Outer wrapper:** `ProcessingQueueProvider` — provides `processAwbAssignments()` function to all dashboard pages via context. This function handles AWB assignment across multiple stores in parallel (groups orders by storeId, calls `/api/shopify/courier/assign-awb` per store, shows toast with link to AWB Processing page on success).

**Sidebar structure (left side, full height):**
- **Header:** Majime logo.
- **Main nav (collapsible sections with ChevronDown):**
  - **Dashboard** — direct link to `/business/{businessId}/dashboard`, highlighted when exactly on that path. Has a ChevronRight indicator when active.
  - **Reports** (FolderClockIcon) — collapsible. Contains: Tax Reports nav item.
  - **Orders** (Package icon) — collapsible. Contains: All Orders, AWB Processing.
  - **Warehouse** (Warehouse icon) — collapsible. Contains: Party Master, Purchase Orders, Process GRNs, Put Away, Credit Notes, Business Products, Inventory, Warehouses, Movements, Activity Logs.
  - **Members** (Users icon) — collapsible. Contains: Requests (super admin only, shown with `isSuperAdmin` check), Invite.
- **Footer (SidebarFooter):**
  - **Business Switcher** — shown only when `joinedBusinesses.length > 1`. Displays current business name in a pill. Clicking opens an AnimatePresence dropdown (above the button, `bottom-full`) listing all businesses. Clicking another business replaces the `businessId` segment in the current pathname and navigates there.
  - **Settings link** — direct link, highlighted when path starts with `/business/{businessId}/settings`.
  - **User profile dropdown** — Avatar (photo or initials fallback), display name, email. Opens a DropdownMenu (align="end", side="top") with: "Your Businesses" link to `/business`, separator, "Log out" (calls `signOut(auth)` then redirects to `/`).

**Active state system for nav items:**
- Each `NavSection` opens automatically when its `isActive` prop is true (path starts with the section's base path).
- Each `NavItem` uses `SidebarMenuSubButton` with an `isActive` style (primary/10 bg, primary text color). When active, a spring-animated `motion.div` with `layoutId="activeIndicator"` appears as a primary-colored vertical bar on the left edge.

**Mobile:** A `SidebarTrigger` in a sticky top header (with Menu icon) opens the sidebar as an overlay. An X close button inside the sidebar closes it.

**Logical connections:** The `processAwbAssignments` function defined here triggers when the user clicks "Assign AWBs" on the Orders page or retries from AWB Processing page. After submission, it shows a toast with a "View Progress" button linking to `/business/{businessId}/dashboard/orders/awb-processing`.

---

### `app/business/[businessId]/settings/layout.tsx` — Settings Sidebar
**Wraps:** All `/business/[businessId]/settings/*` routes

**Left sidebar (desktop, 220px/280px):**
- Header: "Settings" title.
- Nav items (icon + label links):
  - Back to Dashboard → `/business/{businessId}/dashboard/orders`
  - Store Details → `/business/{businessId}/settings`
  - Apps & Integrations → `/business/{businessId}/settings/apps`
  - Pickup Locations → `/business/{businessId}/settings/pickup-locations`
- Footer: Business Switcher (same as dashboard layout, shown when `joinedBusinesses.length > 0`).

**Mobile:** Hamburger Menu button in sticky top header opens a slide-in overlay sidebar from left. Clicking any nav item closes it.

**Active state:** Current path highlighted with `bg-muted text-primary` on the matching nav item.

---

### `app/business/[businessId]/warehouse/layout.tsx` — Warehouse Sidebar
**Wraps:** All `/business/[businessId]/warehouse/*` routes

**Left sidebar (desktop, 280px, `lg:flex`, hidden on smaller screens):**
- **Header:** Gradient primary icon (Warehouse) + "Warehouse" title + "Manage storage locations" subtitle.
- **Nav items (icon + label + description):**
  - Back to Dashboard → `/business/{businessId}/dashboard/orders` (ArrowLeft, always first)
  - Dashed divider with "SECTIONS" label
  - Party Master (Handshake), Purchase Orders (MessageCircleReplyIcon), GRNs (Shirt), Put Away (Truck), Business Products (Package), Inventory (Warehouse), Warehouses (LayoutGrid), Movements (GitBranch), Activity Logs (History)
- **Active state:** Active item gets a `motion.div` with `layoutId="activeNavGlow"` — a spring-animated gradient background (primary color). Non-active items show icon in `bg-muted`, text in muted. ChevronRight appears on active item.
- **Footer:** Business Switcher (same design as dashboard but different positioning).

**Mobile (top horizontal nav, fixed, `lg:hidden`):**
- Horizontal scrollable pill buttons for each nav item. Active item: primary bg + primary-foreground text. ArrowLeft button for Back to Dashboard.

**Active logic for Warehouses:** The `/warehouse` route is only active when path exactly equals it (to avoid `/warehouse/GRNs` also highlighting it).

---

## FRONTEND PAGES — DETAILED UI & BEHAVIOR

### Business List
**URL:** `/business`

**Wraps in:** `app/business/layout.tsx` (auth gate only)

**Full-screen layout, not wrapped in any sidebar.**

**Header (sticky):** Majime logo + "Businesses" title.

**Promotional Banner (conditional, shown when user is NOT already a vendor on both shared stores):**
- `Card` with 2px primary/30 border and gradient background.
- Header: Sparkles icon on primary bg + "Join MAJIME's own business" title + "Exclusive Access" badge.
- Three feature cards (Package/Zap/Contact icons): "Let us sell your products", "All orders on a single Dashboard", "Contact us".
- CTA section: "Ready to get started?" + "Join MAJIME Now" button → navigates to `/join-majime`.
- Visibility logic: Fetches user's Firestore doc, checks if `stores` array contains only shared store IDs. If not vendor → show banner. Super admin never sees it.

**Business Grid:**
- Calls `GET /api/business/list` on mount with Firebase ID token.
- Shows animated skeleton cards while loading (`SkeletonPulse` components).
- Each business shown as a `Card`: Building2 icon + business name + member count + Crown badge if `isOwnBusiness`. Clicking navigates to `/business/{businessId}/dashboard`.
- Own business is always first in the sorted list.
- Empty state: dashed border card "No businesses found".
- Error state: full-screen error with destructive icon + "Try Again" button that reloads the page.

**Logical connection:** This is the entry point after login. Once a business is selected, user navigates to the dashboard layout.

---

### Business Home
**URL:** `/business/{businessId}`

**Wraps in:** `app/business/[businessId]/layout.tsx`

**Not a real page** — immediately calls `router.replace()` to `/business/{businessId}/dashboard` (authorized) or `/login?redirect=...` (not authorized). Shows a brief "Redirecting to dashboard..." spinner during the redirect.

---

## DASHBOARD PAGES

### Dashboard Home
**URL:** `/business/{businessId}/dashboard`

**Wraps in:** `BusinessLayout` (dashboard sidebar), `BusinessContext`

**APIs used:**
- `POST /api/business/table-data` — queues Order Summary table computation. Fire-and-forget.
- `POST /api/business/generate-gross-profit-report` — queues Gross Profit report. Fire-and-forget.
- `POST /api/business/generate-remittance-table` — queues Remittance table. Fire-and-forget.
- `POST /api/business/generate-tax-report` — queues a tax report job (called from Gross Profit table's Sale row download button).
- `POST https://...cloudfunctions.net/purchaseReport` — external Cloud Function for Purchase report download.
- `POST https://...cloudfunctions.net/inventorySnapshotOfADate` — external Cloud Function for Opening/Closing Stock downloads.
- Firestore `onSnapshot` on `users/{businessId}` doc — drives real-time updates of all three report states (`tableData`, `grossProfitData`, `remittanceTable` fields).

**Page layout:** Single scrollable column (`main.flex.flex-1.flex-col.gap-4.p-4`).

**Header row:**
- Left: "Dashboard" h1 + "Order analytics for your business" subtitle.
- Right controls: Store selector (Select — "All Stores" or individual store), Date preset selector (Today/Yesterday/Last 7 Days/Last 30 Days/Custom), if Custom: a Popover calendar (range mode, 2 months side-by-side), Refresh button (RefreshCw icon, spins when loading, shows cooldown countdown badge in top-right corner).
- Below header: date range label text.

**Order Summary Card (`tableData` from Firestore):**
- Shows Table with rows: Gross Sales (+), Cancellations (−), Returns (−), Net Sales (=), then expandable sub-rows (Pending Dispatch, In-Transit, Delivered each expandable to per-status breakdown).
- Net Sales row is clickable (ChevronRight/Down toggle) — expands to show Pending Dispatch, In-Transit, Delivered. Each of those is also expandable to show individual status rows (e.g. New, Confirmed, Ready To Dispatch under Pending Dispatch).
- Columns: Particulars, Order Count, Item Count, Net Sale Value.
- "Last updated" timestamp shown in Card header right side.
- Error state: red alert bar with Retry button.
- Empty state: "No data available. Click refresh to load data" with Load Data button.
- Cooldown: 3-second debounce on manual refreshes (shows countdown in Refresh button).

**Gross Profit Report Card (`grossProfitData` from Firestore):**
- Controls: Date preset selector, optional custom calendar Popover, Refresh button (with cooldown countdown), Download Excel button (shown when `downloadUrl` exists and data is loaded).
- Shows Table with rows: Sale, Sale Return, Purchase, Credit Notes, Opening Stock, Closing Stock, Lost (...), Gross Profit.
- Columns: Type, Qty, Taxable Amt, IGST, CGST, SGST, Net Amount, [action button column].
- Row styling: Gross Profit row has green tinted background + bold. Sale Return/Purchase/Opening Stock/Lost rows have red text. Credit Notes row renders in default color (it is a positive/recovery row, not negative).
- Action buttons (Download icon, last column, per row):
  - **Sale row:** Download icon → calls `POST /api/business/generate-tax-report` (queues tax report job) → shows toast with "View Progress" button linking to `/business/{businessId}/dashboard/reports/tax`.
  - **Purchase row:** Download icon → calls external `purchaseReport` Cloud Function → triggers direct file download.
  - **Opening Stock row:** Download icon → calls `inventorySnapshotOfADate` Cloud Function with `date = grossProfitData.startDate - 1 day` → direct download.
  - **Closing Stock row:** Download icon → calls `inventorySnapshotOfADate` Cloud Function with `date = grossProfitData.endDate` → direct download.
  - **Credit Notes row:** No action button — data is already represented in the CN list page.
- Loading skeleton: 8 skeleton rows while `grossProfitData.loading === true`.

**Remittance Card (`remittanceTable.blueDart` or `.delhivery` from Firestore):**
- Controls: Courier selector (Blue Dart / Delhivery), date range calendar Popover (range mode, 2 months), Refresh button (with cooldown and "Select a date range first" tooltip when no dates).
- Table: Date (remittance date), Order Delivered Range (e.g. "2024-01-15 to 2024-01-20"), Amount (currency), Orders (count + Download CSV button per row).
- Download CSV button (per row): triggers `downloadAwbCsv()` which creates a CSV of AWB numbers in that remittance period.
- Total row at bottom (bold, gray background).
- Empty state: "Select a courier and date range above to generate the remittance table."

**Logical connections:**
- The "Generate Tax Report" button on the Sale row creates a job visible on the Tax Reports page.
- Date range here is independent of the Gross Profit and Remittance date ranges — each section has its own.
- Firestore `onSnapshot` on the business doc means all three tables update in real-time when the Cloud Functions finish computing.

---

### Orders Page
**URL:** `/business/{businessId}/dashboard/orders`

**Wraps in:** `BusinessLayout` (dashboard sidebar), `ProcessingQueueProvider`

**APIs used:**
- `useOrders` hook → Firestore queries on `accounts/{storeId}/orders` across all stores in parallel.
- `useOrderCounts` hook → `onSnapshot` on `accounts/{storeId}/metadata/orderCounts`.
- `useAvailabilityCounts` hook → computes Confirmed tab availability breakdowns.
- `useRtoInTransitCounts` hook → computes RTO In Transit tag breakdowns.
- `useAwbCount` hook → counts `users/{businessId}/unused_awbs` docs.
- `useAllOrderIds` hook → fetches all order IDs matching current filters (triggered by "Select all N orders" click).
- Multiple mutations via `useUpdateOrderStatus`, `useBulkUpdateStatus`, `useRevertOrderStatus`, `useDispatchOrders`, `useOrderSplit`, `useReturnBooking`, `useDownloadSlips`, `useDownloadExcel`, `useDownloadProductsExcel`.
- `POST /api/shopify/orders/bulk-update-status` — Confirm, Close, RTO Close, Lost.
- `POST /api/shopify/orders/dispatch` — enqueues dispatch Cloud Tasks.
- `POST /api/shopify/courier/assign-awb` — via `processAwbAssignments` from context.
- `POST /api/shopify/courier/bulk-book-return` — bulk return booking.
- `POST /api/shopify/orders/revert-to-confirmed`, `revert-to-delivered` — single-order reversals.
- `POST /api/shopify/orders/split-order` — order split.
- `POST /api/shopify/orders/export` → .xlsx download.
- `POST /api/shopify/orders/download-slips` → PDF download.
- `POST /api/shopify/orders/export-products` → products .xlsx download.
- `POST /api/shopify/orders/mark-packed` — from StartPackagingDialog.
- `POST /api/shopify/orders/make-pickup-ready` — from PerformPickupDialog.
- `POST /api/shopify/orders/qc-test` — from StartQcDialog.
- `POST /api/shopify/orders/refund` — from RefundDialog.
- `POST /api/business/generate-tax-report` — from TaxReportDialog.
- `POST /api/shopify/orders/generate-purchase-order` — from GeneratePODialog.
- `POST /api/shopify/orders/update-confirmed-orders-availability-tag` — from AvailabilityDialog.

**Page layout:** Flex column, full height, no overflow-y (inner sections scroll independently).

**Sticky top header (bg-card/80, backdrop blur):**
- Left: "Orders" h1 + stores count subtitle (e.g. "All 2 stores").
- Right: Refresh button (RefreshCw, spins when fetching), More menu (VerticalDots DropdownMenu):
  - **Tax Report** (FileSpreadsheet) — super admin only → opens TaxReportDialog.
  - **Perform Items Availability** (Shirt) — Confirmed tab only → opens AvailabilityDialog.
  - **AWB Bulk Select** (AlignLeft) — Ready To Dispatch / RTO Delivered / RTO In Transit tabs → opens AwbBulkSelectionDialog (barcode scanner to bulk-select orders by AWB).
  - **Start Packaging** (Package) — Ready To Dispatch tab only → opens StartPackagingDialog.
- Below: Search bar (Search icon left, X clear button right, "Search orders..." placeholder).
- Filters Sheet trigger button (Filter icon + "Filters" text + count badge of active filters).

**Filters Sheet (slides in from right, `sm:max-w-md`):**
- Payment Type: All / Prepaid / COD (Select).
- State: All States / dynamic provinces populated from current result set (Select).
- Stores: Clear All / Select All buttons + checkbox list of all stores.
- Date Range: two native `<input type="date">` inputs (From / To), Clear Date Range button.
- Courier filter (hidden for New/Confirmed/Cancelled tabs): All / Blue Dart / Delhivery / Shiprocket / Xpressbees.
- Packed Status (Ready To Dispatch tab only): All / Packed / Not Packed.
- Availability filter (Confirmed tab only): All Items / Picked up (count) / Pickup Eligible (count) / Not Pickup Eligible (count) / Unmapped (count).
- RTO Status filter (RTO In Transit tab only): All / Re-attempt (count) / Refused (count) / No Reply (count).
- Invert Search toggle (Switch).
- "Apply Filters" button closes the sheet.

**Status tabs (horizontal scroll, pill buttons below header):**
21 tabs: All Orders, New, Confirmed, Ready To Dispatch, Dispatched, In Transit, Out For Delivery, Delivered, RTO In Transit, RTO Delivered, DTO Requested, DTO Booked, DTO In Transit, DTO Delivered, Pending Refunds, DTO Refunded, Lost, Closed, RTO Closed, Cancellation Requested, Cancelled. Each shows count from `orderCounts` snapshot. Active tab: primary bg + primary-foreground text.

**Bulk Actions Bar (shown when `selectedOrders.length > 0`):**
- Checkbox (select/deselect all on current page), "{N} selected" text, Clear button.
- "Download" dropdown (Download icon + ChevronDown):
  - Download Excel (always visible)
  - Download Slips (hidden for All Orders/New/Confirmed/Cancellation Requested/Cancelled)
  - Download Products (Confirmed + Ready To Dispatch tabs only)
- "Actions" dropdown (ChevronDown):
  - Confirm — New tab
  - Generate PO — Confirmed tab (validates single store, opens GeneratePODialog)
  - Assign AWBs — Confirmed tab (not shown for non-admin on shared store orders)
  - Dispatch — Ready To Dispatch tab
  - Close Orders — Delivered tab
  - Mark RTO Closed — RTO In Transit tab (always creates UPCs)
  - RTO Close — RTO Delivered tab
  - Book Returns — DTO Requested tab
- **Select-all-pages banner** (shown when all current-page orders selected AND total > rowsPerPage): "{N} of {total} orders selected" — allows extending selection across all pages up to 2000 orders.

**Order content area:**
- **Mobile (md:hidden):** `MobileOrderCard` components — each card shows: order name + store domain (truncated), status badge (All Orders tab only), MoreVertical dropdown menu, customer name + total price + outstanding price, date badge + payment badge + AWB last 6 chars badge + item count badge. Clicking card body opens Order Detail Dialog.
- **Desktop (hidden md:block):** Standard HTML `Table` with sticky header. Columns: checkbox, Order (name), Store (domain.split('.')[0]), Date, Status (All Orders tab only), AWB (non-New/Confirmed/Cancelled/All tabs), Return AWB (DTO Booked/In Transit/Delivered/Pending Refunds/Refunded tabs), Customer, Total, Outstanding, Payment badge, Fulfillment badge, Items count, Actions dropdown. Clicking row opens Order Detail Dialog.

**Per-order action dropdown (MoreHorizontal on desktop, MoreVertical on mobile):**
Renders context-specific actions based on `order.customStatus`:
- **New:** Confirm, Split Order (shared-store admin only)
- **Confirmed:** Assign AWB, Split Order (admin only), Perform Pickup (if `isEligibleForPickup`)
- **Ready To Dispatch:** Back to Confirmed, Dispatch
- **Delivered:** Book Return (opens BookReturnDialog)
- **DTO Requested:** Book Return, Back to Delivered
- **DTO Booked:** Back to Delivered, Close Order
- **DTO In Transit / DTO Delivered:** Start QC (opens StartQcDialog)
- **Pending Refunds:** Process Refund (opens RefundDialog)
- **RTO Delivered / RTO In Transit:** Mark as Lost
- **Closed:** Undo Closed (Back to Delivered)
- **Cancellation Requested:** Back to Confirmed

**Order Detail Dialog (clicking any row):**
- `max-w-4xl`, max 90vh, scrollable inner content.
- Two-column grid on desktop.
- **Left column:** Status badges (customStatus, financialStatus, fulfillment), Vendors list (shared store), Shipment details (courier name bold+underline+italic, AWB bold, return courier, return AWB), Customer block (name, email, shipping address multiline, phone), Items table (name, SKU, qty, price per item), Total row, Packing Videos list (if any — shows "Packing Video N" + packed timestamp as links with ExternalLink icon, grouped in muted cards).
- **Right column:** History/status log (sorted newest first — each entry: Clock icon in muted circle + status name + date/time + optional remarks).
- **Footer (shown when has AWB + courier):** "Track Forward Order" button → links to courier tracking page (Delhivery/Shiprocket/Xpressbees).

**Pagination footer (sticky bottom):**
- "{from}-{to} of {total}" count text (hidden on mobile, shows "{total} orders" instead).
- Rows per page selector (10/20/50/100/200, saved to localStorage).
- Prev/Next page buttons + "currentPage/totalPages" display.

**Syncing indicator:** A fixed pill at bottom center ("Syncing..." with spinning Loader2) when `isFetching && !isLoading`.

---

### AWB Processing
**URL:** `/business/{businessId}/dashboard/orders/awb-processing`

**Wraps in:** `BusinessLayout` (dashboard sidebar), `ProcessingQueueProvider`

**APIs used:**
- Firestore `onSnapshot` on `users/{businessId}/shipment_batches` or `book_return_batches` (ordered by createdAt desc, limit 50).
- `useAwbCount` hook — for low AWB warning dialog.
- `POST /api/shopify/courier/download-jobs` — downloads Excel of success/failed jobs per batch.
- `POST /api/shopify/courier/assign-awb` — via `processAwbAssignments` context function (used for retry).
- Firestore `getDocs` on `users/{businessId}/{collectionName}/{batchId}/jobs` filtered to failed status — for retry.
- `POST /api/shopify/courier/fetch-awbs` — from GenerateAwbDialog (button in header).

**Page layout:** Two sections — header bar + main card content.

**Header bar (border-b, bg-background):**
- Left: Truck icon + "AWB Processing" h1 + "{N} stores" subtitle.
- Right: "Generate AWBs" button (PackagePlus icon) → opens `GenerateAwbDialog`.

**Main card (fills remaining height, flex flex-col):**
- **Card header:** "Assignment History" / "Return History" title, "View ongoing and completed batch operations" description. Right side: Select dropdown (`Forward Shipments` / `Return Shipments`) — switching updates `batchType` state which changes the Firestore collection being listened to.
- **Card content (ScrollArea):**
  - **Empty states:** NoStoresState (no stores connected), EmptyState (no batches yet, with contextual message for forward vs return).
  - **Skeleton:** 3 `BatchRowSkeleton` cards while loading.
  - **Ongoing section** (running/incomplete batches): Pulsing green dot + "Ongoing (N)" header. List of `BatchRow` components.
  - **Completed section** (finished batches): "Completed (N)" header. List of `BatchRow` components.

**`BatchRow` component:**
- Border card, primary/30 tinted border if running, destructive/30 if has failures.
- Left: Status icon in colored circle (Loader2 spinning=running, CheckCircle=completed, XCircle=failed).
- Batch info: "Batch {id[:8]}..." text + courier Badge + Clock icon + timestamp.
- **Desktop buttons (hidden md:flex):**
  - "Success" download button (Download icon) — shown when `batch.success > 0`.
  - "Failed" download button — shown when `batch.failed > 0`.
  - "Retry" button (RotateCcw, with Tooltip "Re-enqueue failed jobs") — shown when failed > 0 AND batchType is forward. Clicking fetches failed job docs from Firestore, extracts order IDs, calls `handleAssignAwbClick(ordersToProcess)` which opens AssignAwbDialog.
- **Mobile:** MoreVertical DropdownMenu with same actions.
- Progress bar: shows `(success + failed) / total * 100%`, with green "X success" and red "X failed" counts below.

**Low AWB Alert Dialog:** If user tries to assign more orders than available AWBs, opens `AlertDialog` with "Not Enough AWBs" → "Generate More AWBs" button switches to GenerateAwbDialog.

**AssignAwbDialog:** 3-step process — Step 1: select courier (Delhivery/Shiprocket/Xpressbees/Blue Dart/Priority), Step 2: select pickup location (from `users/{businessId}/pickupLocations`), Step 3: review + submit.

**Logical connections:**
- This page is navigated to from the Orders page when clicking "View Progress" in the AWB assignment success toast.
- Failed job retry re-opens the AssignAwbDialog from this page.
- GenerateAwbDialog hits `POST /api/shopify/courier/fetch-awbs` to bulk-fetch AWBs from Delhivery into the pool.

---

### Tax Reports
**URL:** `/business/{businessId}/dashboard/reports/tax`

**Wraps in:** `BusinessLayout` (dashboard sidebar)

**APIs used:**
- Firestore `onSnapshot` on `users/{businessId}/tax_reports` (ordered by `startedAt` desc, paginated at 20 per page with cursor-based pagination using `startAfter`).

**Page layout:** Header bar + main card (filling height).

**Header bar:** FileSpreadsheet icon + "Tax Reports" h1 + "View and download generated tax report files" subtitle.

**Main card:**
- **Header:** "Report History" title + "All tax report generation jobs, newest first" description. Right: Status filter Select (`All Statuses` / generating / uploading / completed / failed — each shows count badge).
- **Content (ScrollArea):** 
  - Loading: 4 `ReportCardSkeleton` animated placeholders.
  - Empty: FileSpreadsheet icon + "No Reports Found" + contextual message ("Queue a tax report from the Dashboard...").
  - Reports: list of `ReportCard` components.

**`ReportCard` component:**
- Border card, primary/30 tinted when active (generating/uploading), destructive/30 when failed.
- Status icon in colored circle: Loader2 spinning (generating), RefreshCw spinning (uploading), CheckCircle green (completed), XCircle red (failed).
- Date range display: "15 Jan 2024 → 31 Jan 2024" format. Status badge (colored text).
- Timestamp + elapsed time "(32s)" or "(2m 15s)".
- **Desktop:** "Download Excel" button (shown only for completed with downloadUrl).
- **Mobile:** MoreVertical dropdown with Download Excel.
- Store ID badges row (one per store covered by the report).
- **Completed:** Summary row: "X sales lines · Y return lines · Z states · W HSN codes".
- **Failed:** Error row: AlertTriangle icon + error message text in destructive/5 background.

**Pagination:** "Load More" button at bottom (ChevronDown icon, shown when `hasMore && statusFilter === 'all'`). Uses `attachListener(lastDocRef.current, true)` to append next page. The `onSnapshot` listener for each page stays alive, meaning real-time updates flow in for all visible reports simultaneously.

**Status filter:** Client-side filtering of the already-fetched reports. Does NOT re-query Firestore — it just hides rows.

**Logical connections:**
- Reports appear here after being queued from Dashboard Home (Sale row download button) or from the TaxReportDialog opened from the Orders page More menu.
- Reports cycle through: `queued` → `generating` → `uploading` → `completed`/`failed`. The page shows live status changes as the Cloud Function processes.

---

### Members — Invite
**URL:** `/business/{businessId}/dashboard/members/invite`

**Wraps in:** `BusinessLayout` (dashboard sidebar)

**APIs used:**
- `POST /api/business/members/create-invite` — creates the invite session.

**Page layout:** Centered card (`max-w-2xl`), 3-step wizard.

**Step 1 — Select Member Role:**
- `RadioGroup` with two large radio cards (full-width labels):
  - **Admin** — "High-level access, can manage settings and other members if permitted." Ring highlight when selected.
  - **Member** — "Basic access to view and manage orders across all stores in the business."

**Step 2 — Set Permissions (shown after role selected):**
- Admin permissions checkboxes: "Can manage other members", "Can change business settings", "Can add/remove stores from business".
- Member permissions checkboxes: "Can view orders across all stores" (pre-checked), "Can manage orders (assign AWB, update status)".

**Step 3 — Generate Link (shown after role selected):**
- "Create Joining Link" button (Link icon, Loader2 while submitting).
- On success: shows Alert with CheckCircle icon + "Link Generated Successfully!" + readonly input with the full URL + Copy button. Below: destructive Alert with "Security Warning" about the link being single-use and 1-hour expiry.
- The generated URL format: `{origin}/join-business/{sessionId}`.

---

### Members — Requests
**URL:** `/business/{businessId}/dashboard/members/requests`

**Wraps in:** `BusinessLayout` (dashboard sidebar)

**Access:** Super admin only (businessId === `SUPER_ADMIN_ID`). Non-super-admins see an "Access Denied" full-screen state with ShieldAlert icon.

**APIs used:**
- Firestore `onSnapshot` on `users/{businessId}/join-requests` where `status == 'pending'` ordered by `requestedAt desc`.
- `POST /api/business/members/accept-request` — accepts a join request.
- `POST /api/business/members/decline-request` — declines a join request.

**Page layout:** Max-w-4xl centered. Header "Join Requests" + description. Empty state (User icon) or list of request cards.

**Request Card (`Card` per request):**
- Avatar (photo URL or initials fallback) + display name (h3) + email (Mail icon) + requested date (Calendar icon) + optional "Vendor: {name}" Badge.
- Optional message in muted background.
- Right side: "Accept" button (Check icon, primary) + "Decline" button (X icon, outline). Both disabled while processing (`processingIds` set).

---

## SETTINGS PAGES

### Settings — Store Details
**URL:** `/business/{businessId}/settings`

**Wraps in:** Settings sidebar layout

**APIs used:**
- Firestore `onSnapshot` on `users/{businessId}` doc — real-time data for `companyAddress`, `primaryContact`, `customerServices`.
- `POST /api/shopify/account/update-address`
- `POST /api/shopify/account/update-contact`
- `POST /api/shopify/account/toggle-service`

**Page layout:** Centered card (`max-w-4xl`), "Store Details" title.

**Company Address section:**
- If no address: dashed border "No company address has been added yet." + "Add Details" button.
- If has address: display as text (address, city/state/pincode, country) + "Edit Details" button.
- Edit mode: grid of inputs (Address, Pincode, City, State, Country) + Cancel/Save buttons.

**Primary Contact section:** Same pattern — display vs edit mode. Fields: Name, Phone, Email.

**Customer Services section:**
- "Enabled Services" heading.
- One service row: "'Booking a return' page" with description "Allows customers to initiate returns from a public page." + Switch (calls `POST /api/shopify/account/toggle-service` with `serviceName: 'bookReturnPage'`). Disabled while toggling.

---

### Settings — Apps & Integrations
**URL:** `/business/{businessId}/settings/apps`

**Wraps in:** Settings sidebar layout

**APIs used:**
- Firestore `onSnapshot` on `users/{businessId}` doc — real-time `integrations.couriers` data.
- `POST /api/integrations/courier/update-priority`
- `POST /api/integrations/courier/update` (Delhivery API key)
- `POST /api/integrations/shiprocket/update`
- `POST /api/integrations/xpressbees/update`
- `POST /api/integrations/bluedart/update`
- `POST /api/integrations/courier/delete`

**Page layout:** Centered card (`max-w-4xl`), "Apps & Integrations" title, TooltipProvider wrapping.

**Courier Priority section:**
- Header: "Courier Priority" title + description + Enable/Disable Switch (disabled when `priorityList` is empty).
- When enabled and `priorityList.length > 0`: "Drag to Reorder Priority" section using `framer-motion Reorder.Group` (drag-and-drop reordering). Each item: GripVertical handle + courier name + (for non-Shiprocket) Surface/Express Select. Reorder or mode change immediately calls `POST /api/integrations/courier/update-priority`.

**Per-courier sections (Delhivery, Shiprocket, Xpressbees, Blue Dart):**
Each follows the same pattern:
- Connected state: "Connected" Badge + "Change Key/Credentials" button + red Trash2 AlertDialog trigger.
  - AlertDialog: "Are you sure?" with description mentioning priority list removal + Cancel/Remove.
- Not connected: "Connect" button.
- Editing state (inline below, `bg-muted/50`):
  - **Delhivery:** single API Key password Input + Cancel/Save Key buttons.
  - **Shiprocket:** Email + Password inputs (validates live against Shiprocket auth API) + Info Tooltip with docs link + Cancel/Save & Connect buttons.
  - **Xpressbees:** Email + Password inputs (validates live) + Cancel/Save & Connect buttons.
  - **Blue Dart:** 6 fields in a grid: App API Key (password), App API Secret (password), Customer Code (text), Login ID (text), Shipping Licence Key (password), Tracking Licence Key (password) + Cancel/Save & Connect buttons.
- All deletions call `POST /api/integrations/courier/delete` which also removes from `priorityList`.

---

### Settings — Pickup Locations
**URL:** `/business/{businessId}/settings/pickup-locations`

**Wraps in:** Settings sidebar layout

**APIs used:**
- Firestore `onSnapshot` on `users/{businessId}/pickupLocations` collection.
- `POST /api/shopify/locations/add`
- `POST /api/shopify/locations/update`
- `POST /api/shopify/locations/delete`

**Page layout:** Centered card (`max-w-4xl`).

**Header:** "Pickup Locations" title + "Manage where customers can pick up their orders." + "Add New Location" button (PlusCircle icon).

**Content:**
- Loading: 2 skeleton cards.
- Empty: dashed border "No pickup locations found. Click 'Add New Location' to get started."
- List: each location as a rounded border row — MapPin icon + name (bold) + address/city/postcode. Edit (pencil) and Delete (Trash2 AlertDialog trigger) buttons on right.

**Add/Edit Dialog:**
- `sm:max-w-[425px]` Dialog with form (uses native form submit, not button with onClick).
- Fields: Name, Address, City, Postcode, Country (all required). Grid layout (label on left, input spanning 3 cols).
- Cancel/Save buttons in DialogFooter.

**Logical connections:** Pickup locations created here appear in Step 2 of the AssignAwbDialog on the Orders page and AWB Processing page.

---

## WAREHOUSE PAGES

### Warehouse Overview
**URL:** `/business/{businessId}/warehouse`

**Wraps in:** Warehouse layout

**APIs used:**
- `GET /api/business/warehouse/list-warehouses?businessId=`
- `GET /api/business/warehouse/list-zones?businessId=&warehouseId=`
- `GET /api/business/warehouse/list-racks?businessId=&zoneId=`
- `GET /api/business/warehouse/list-shelves?businessId=&rackId=`
- `GET /api/business/warehouse/list-placements?businessId=&shelfId=`
- `GET /api/business/warehouse/list-upcs?businessId=&placementId=`
- `POST /api/business/warehouse/create-warehouse`, `PUT update-warehouse`, `DELETE delete-warehouse`
- `POST /api/business/warehouse/create-zone`, `PUT update-zone`, `DELETE delete-zone`, `PUT move-zone`
- `POST /api/business/warehouse/create-rack`, `PUT update-rack`, `DELETE delete-rack`, `PUT move-rack`
- `POST /api/business/warehouse/create-shelf`, `PUT update-shelf`, `DELETE delete-shelf`, `PUT move-shelf`
- `POST /api/business/warehouse/create-instant-warehouse`

**Page layout:** `min-h-full p-6 space-y-6`.

**Header row:** "Warehouse Overview" h1 + description. Buttons: "Quick Setup" (FolderTree icon → InstantWarehouseDialog) + "Add Warehouse" (Plus icon → WarehouseDialog).

**Stats row (5 cards, 2-col on mobile, 5-col on desktop):**
Warehouses (blue), Zones (emerald), Racks (amber), Shelves (purple), Products (rose). Values computed from `warehouses.reduce()` over `w.stats.*` fields.

**Tree View Card:**
- Card header: FolderTree icon + "Warehouse Structure" title + description. Search input (by name or code) + Refresh button.
- Content: Lazy-loaded tree. Clicking a node fetches its children on first expand (memoized — not re-fetched if already loaded).
- **`TreeNode` component:** Level-indented (paddingLeft = `level * 20 + 12`px). ChevronRight (animated rotation on expand) or Loader2 while fetching. Icon in colored bg. Name + Code badge. Stats badges (e.g. "3 zones"). MoreHorizontal DropdownMenu (appears on hover: opacity-0 → opacity-100). Actions: Add Child / Edit / Move / separator / Delete (destructive text).
- **Warehouse level (blue):** Add Zone, Edit, Delete.
- **Zone level (emerald):** Add Rack, Edit, Move, Delete.
- **Rack level (amber):** Add Shelf, Edit, Move, Delete.
- **Shelf level (purple):** Edit, Move, Delete (no Add — placements are auto-created).
- **Placement level (violet Package icon):** Shows `productId` + "Qty: N" badge. Expandable to show individual UPC rows.
- **UPC level (blue Package icon):** Shows UPC ID + creation date badge. No actions.

**Dialogs:**
- **WarehouseDialog / ZoneDialog / RackDialog / ShelfDialog:** Similar structure. Create: name (required) + code (required, `toUpperCase()`, disabled on edit with "Code cannot be changed" note) + optional fields (address for warehouse, description for zone, position + capacity for rack/shelf). Edit: same but code field disabled.
- **DeleteDialog:** AlertDialog. Shows child count warning if `hasChildren` (e.g. "This warehouse has 3 zones. You must remove all zones before deleting."). Delete button disabled if `hasChildren`.
- **MoveDialog (Zone/Rack/Shelf):** `sm:max-w-lg`, shows current location. Lazy-loaded tree picker to select destination. Shows "current" badge on the entity's current parent. Position field for rack/shelf moves. Shows selected destination below the tree.
- **InstantWarehouseDialog:** "Quick Warehouse Setup". Fields: Name + Code + Address + Zone count (1-50) + Racks per zone (1-50) + Shelves per rack (1-20). Live preview showing totalZones/Racks/Shelves/Entities. Code naming preview (e.g. `WH01-Z01-R01-S01`). Warning if >5000 entities. Calls `POST /api/business/warehouse/create-instant-warehouse`.

**Logical connections:**
- Shelves created here appear as drop targets in the Put Away page.
- Products placed on shelves here are tracked by the Inventory page.
- Movements generated by put-away actions appear on the Movements page.
- Activity logs for zone/rack/shelf changes appear on the Activity Logs page.

---

### GRNs (Goods Receipt Notes)
**URL:** `/business/{businessId}/warehouse/GRNs`

**Wraps in:** Warehouse layout

**APIs used:**
- Firestore `getDocs` on `users/{businessId}/grns` (ordered by `createdAt desc`) via `useGRNs` hook (TanStack Query, refetch every 60s).
- Firestore `onSnapshot` on `users/{businessId}/purchaseOrders` where `status in ['confirmed', 'partially_received']` via `useReceivablePOs` hook (real-time).
- `POST /api/business/warehouse/grns/create`
- `POST /api/business/warehouse/grns/update` (status transitions: draft→completed/cancelled, item edits on draft GRNs)
- `POST /api/business/warehouse/grns/delete` (cancelled GRNs only)
- `POST /api/business/warehouse/grns/confirm-put-away` (creates UPC docs, marks GRN completed)
- `POST /api/business/warehouse/grns/download-bill` → PDF download

**Page layout:** `min-h-full p-6 space-y-6`.

**Header:** "Goods Receipt Notes" h1 + description. Buttons: "Refresh" (RefreshCw) + "Create GRN" (Plus).

**Stats (6 cards, 2-col / 3-col / 6-col):** Draft, Completed, Cancelled, Total Expected qty, Total Received qty, Not Received qty. Clicking status cards toggles that status as the active filter.

**Filters Card:** Search input (GRN number, PO number, SKU, warehouse) + Status filter Select + Sort order Select.

**Table Card:**
- Loading: 5 skeleton rows.
- Empty: ClipboardCheck icon + "No GRNs Yet" / "No Matching Results" + Create GRN button (if empty).
- Columns: GRN # (sortable), Bill # (sortable), PO # (linked PO), Warehouse, Expected qty, Received qty (emerald text), Not Received qty (amber text if >0), Value (currency, sortable), Status badge, Received date (sortable).
- Clicking row → opens `GRNDetailDialog`.
- MoreHorizontal dropdown per row:
  - View Details
  - **Download Bill PDF** (Loader2 while generating) — calls `/api/business/warehouse/grns/download-bill`. Shows loading toast "Generating PDF..." → success toast "PDF Downloaded". Downloads `{billNumber}.pdf`.
  - (draft only) Confirm Put Away → opens `ConfirmPutAwayDialog`
  - (draft only) Cancel GRN → immediately calls update API to set status 'cancelled'
  - (cancelled only) Delete → opens delete AlertDialog.
- Pagination: prev/next buttons + page number buttons (max 5 shown, sliding window).

**GRN Form Dialog (Create):**
- `sm:max-w-2xl`, scrollable.
- Step 1: PO selector (Select, shows only receivable POs — confirmed/partially_received). Selected PO shows blue info box with supplier + warehouse details.
- Bill/Invoice Number input (text).
- Items populated automatically from selected PO: per-item row shows SKU + product name + Expected qty (readonly, shows remaining after previous GRNs) + Received qty (editable, defaults to expected, highlights amber if over-received) + Not Received qty (auto-calculated, readonly) + Unit Cost (readonly from PO). Over-received items show "Over-received by N" warning. Per-item received value shown.
- Total received value summary.
- Notes textarea.
- Create GRN button (disabled until PO selected + at least one item has receivedQty > 0).

**GRN Detail Dialog:** Read-only display of all GRN fields. 3 colored stat boxes (Expected/Received/Not Received). Notes section. Line items Table (SKU, Product, Expected, Received with +over indicator, Not Received amber, Value).

**Confirm Put Away Dialog:** AlertDialog confirming UPC creation. Shows Table of items to be received with UPC count per item. Total UPCs. "Confirm (N UPCs)" button. On success: invalidates GRN + PO queries.

**Logical connections:**
- GRNs link to POs (created on the POs page). A PO must be Confirmed or Partially Received to create a GRN against it.
- "Confirm Put Away" creates UPCs that appear in the Put Away page → Inbound → GRNs sub-section.
- GRN completion updates the PO's `receivedQty` per item and recalculates PO status.

---

### Purchase Orders
**URL:** `/business/{businessId}/warehouse/POs`

**Wraps in:** Warehouse layout

**APIs used:**
- `getDocs` on `users/{businessId}/purchaseOrders` via `usePurchaseOrders` (TanStack Query, refetch 60s).
- `getDocs` on `users/{businessId}/products` via `useProducts`.
- `getDocs` on `users/{businessId}/parties` (filtered to supplier/both, active) via `useSupplierParties`.
- `getDocs` on `users/{businessId}/warehouses` (not deleted) via `useWarehouses`.
- `POST /api/business/warehouse/purchase-orders/create`
- `POST /api/business/warehouse/purchase-orders/update` (status transitions + item edits)
- `POST /api/business/warehouse/purchase-orders/delete`

**Page layout:** `min-h-full p-6 space-y-6`.

**Header:** "Purchase Orders" h1 + description. Buttons: Refresh + "Create PO" (Plus).

**Stats (6 cards):** Draft, Confirmed, Partial, Received, Closed, Cancelled. Clicking toggles as filter.

**Filters Card:** Search (PO number, supplier, SKU, warehouse) + Status filter Select + Sort order Select.

**Table:**
- Columns: PO # (sortable), Supplier (name + ID below), Warehouse, Items count, Amount (sortable), Expected date (sortable), Status badge, Created date (sortable), Actions.
- Clicking row → opens `PODetailDialog`.
- Actions dropdown per row:
  - View Details
  - Edit (draft + confirmed statuses only)
  - separator
  - Confirm & Send (draft only) — updates status to `confirmed`
  - Close PO (fully_received only) — updates to `closed`
  - separator
  - Cancel PO (draft + confirmed) — opens `CancelPODialog`
  - Delete (draft + cancelled only)
- Pagination: same sliding 5-page window.

**PO Form Dialog:**
- Supplier search (`SupplierSearchInput`): live-search text input + dropdown showing party name/code/GSTIN. CheckCircle on selected. Emerald border when selected.
- Warehouse selector (Select from fetched warehouses). Warehouse Name auto-filled (readonly).
- Expected Date (date input).
- Currency selector (INR/USD/EUR).
- Line items: "Add Item" button appends a new row. Each row: product search (`ProductSearchInput` — searches by SKU or name, prevents duplicates with "Already added" badge) + Product Name (auto-filled readonly) + Quantity + Unit Cost + Remove X button. Subtotal shown per row. Duplicate SKU validation error shown above items section. Total shown at bottom.
- Notes textarea.
- Duplicate SKU detection disables the Create/Update button.

**PODetailDialog:** Full PO details in a 2-column grid: supplier info, warehouse, expected date, total amount, created/confirmed/completed/cancelled timestamps. Notes. Line items table with SKU, Product, Expected qty, Received qty, Unit cost, status badge per item.

**CancelPODialog:** Separate Dialog (not AlertDialog) — requires entering a cancellation reason (Textarea). "Confirm Cancel" sends reason in the update request.

**`ProductSearchInput` component:** Animated dropdown (framer-motion) with list of filtered products (max 20). Marks already-added products with amber "Already added" badge and disables them. Shows "No product found" state.

**`SupplierSearchInput` component:** Same pattern but for party search (name, code, GSTIN, contactPerson). Shows Check icon on selected party.

---

### Inventory
**URL:** `/business/{businessId}/warehouse/inventory`

**Wraps in:** Warehouse layout

**APIs used:**
- Firestore `onSnapshot` on `users/{businessId}/products` — real-time inventory data.
- `GET /api/business/warehouse/list-warehouses`, `list-zones`, `list-racks`, `list-shelves` (for AdjustmentDialog tree).
- `GET /api/business/warehouse/list-product-placements` (for deduction placement selection).
- `POST /api/business/inventory/adjust` — adjusts inwardAddition or deduction fields.
- ExcelJS for client-side Excel export.

**Page layout:** Full-height flex column with sticky header, stats row, then main card.

**Header:**
- Left: Indigo gradient Warehouse icon + "Stock Overview" h1 + subtitle.
- Right buttons: "Export Inventory" (Download icon → generates Excel client-side via ExcelJS and triggers download), "Bulk Inward" (Package → opens `BulkInwardDialog`), "Products" link (→ `/business/{businessId}/products`, but note this is the old path — actual products page is at `/warehouse/products`).

**Stats cards (5, gradient-tinted):** Physical Stock (blue), Available Stock (emerald), Blocked Stock (amber), Low Stock count (orange), Out of Stock count (rose).

**Main Card (shadow-xl, ring-1):**
- **Filter row (bg-muted/30):** Search input (name or SKU, debounced 300ms) + Category filter Select + Stock Status filter (In Stock / Low Stock / Out of Stock).
- **Table (sticky header, bg-muted/50):**
  - Loading: 5 animated skeleton rows.
  - Empty (no products): PackageOpen icon + "No products yet" + "Go to Products" button.
  - No search results: Search icon + "No results found" + Clear Filters button.
  - Columns: Product (icon + name + SKU code), Opening, Inward (+N buttons, currently onClick is commented out), Deduction (−N buttons, commented out), Auto + (blue), Auto − (violet), Physical (bold, red if ≤0), Blocked (amber), Available (Badge — red/amber/green tinted).
  - Each row is an animated `motion.tr` (staggered entrance).
- **Pagination footer:** "{from} to {to} of {total}" + rows per page Select (10/25/50/100) + Prev/Next page buttons + current/total pages display.

**AdjustmentDialog (currently accessible but buttons commented out in table):**
- `sm:max-w-[600px]`, flex column with scrollable location selection.
- Shows current Physical Stock + Available Stock.
- Quantity input (Plus/Minus icon, validates against stock floor for deduction).
- **For Inward:** Tree picker (Warehouse → Zone → Rack → Shelf, lazy-loaded, same expand pattern as warehouse page). Select a shelf = target location.
- **For Deduction:** List of placements where this product currently has stock (from `list-product-placements`). Each shows location path + "Qty: N" badge. Selecting checks if deduction amount exceeds placement quantity.
- Preview section: shows `Physical → NewPhysical` and `Available → NewAvailable` arrows (and location qty change for deduction).

**Excel export:**
- Client-side using ExcelJS. Columns: Product Name, SKU, Category, Opening Stock, Inward Addition, Deduction, Auto Addition, Auto Deduction, Physical Stock, Blocked Stock, Available Stock, Status.
- Header row: bold white text on indigo (#4F46E5) background.
- Status column color-coded: Out of Stock (red bg + red text), Low Stock (amber bg), In Stock (green bg).
- Physical stock in red+bold if ≤ 0. All cells have thin border.

---

### Put Away
**URL:** `/business/{businessId}/warehouse/put-away`

**Wraps in:** Warehouse layout

**APIs used:**
- Firestore `getDocs` on `users/{businessId}/upcs` (all UPCs) via `usePutAwayUPCs` (TanStack Query, refetch 30s).
- Firestore `getDoc` on individual order docs to resolve order name/status for outbound/dispatched UPCs.
- Firestore `getDoc` on `users/{businessId}/credit_notes/{cnId}` — to resolve credit note doc IDs to human-readable CN numbers.
- `GET /api/business/warehouse/list-warehouses`, `list-zones`, `list-racks`, `list-shelves` — for location selector.
- `POST /api/business/warehouse/put-away-batch` — assigns inbound UPCs to shelf location. Max 100 UPCs.
- `POST /api/business/credit-notes/dispatch-upcs` — removes credit note UPCs from inventory (Outbound → To be Removed tab).
- `GET /api/business/warehouse/grns/{grnId}` (via `getDoc`) — to resolve GRN doc IDs to human-readable GRN numbers.

**Page layout:** `min-h-full p-6 space-y-6`.

**Header:** "Put Away Management" h1 + description. "Refresh" button (invalidates all put-away queries).

**Stats row (6 cards):** Inbound total, GRN count, RTO count, DTO count, Outbound count, Dispatched count.

**Main tabs:** Inbound / Outbound / Dispatched.

**Inbound Tab:**
- **Filter bar card** — context-sensitive:
  - GRN sub-tab: live search input (searches by GRN number, UPC ID, product SKU). Shows matched count.
  - Other sub-tabs: date range filter (From/To date inputs). Shows matched count.
- **Sub-tabs:** GRNs / RTO Returns / DTO Returns / Unknown (each with count badge).

**GRNs sub-tab (`GRNGroupedUPCList`):**
- Groups inbound UPCs by `grnRef` field. GRN doc IDs resolved to `grnNumber` via `useGrnNumberMap` hook.
- Each GRN group: teal ClipboardCheck icon + GRN number (monospace) + UPC count badge + product count + date. "Select GRN" button (toggles all UPCs in group).
- Within each group: list of UPC rows — Checkbox + UPC ID (monospace) + product SKU badge + time.
- Global "Select All" / "Deselect All" button + "Put Away (N)" button at top.

**RTO Returns / DTO Returns / Unknown sub-tabs (`DateGroupedUPCList`):**
- Groups UPCs by date (from `updatedAt`). Date header: "Monday, 20 January 2025 (N UPCs)".
- Within each date group: list of UPC rows with order name, store name, order status badge + time.
- Global "Select All" + "Put Away (N)" button.

**Outbound Tab:** Shows all `putAway === 'outbound'` UPCs split into two sub-tabs:

- **To be Dispatched** (`creditNoteRef: null`) — UPCs reserved for courier pickup by an active order. Date range filter at top. **Checkboxes and put-away button are hidden** — these UPCs cannot be manually acted on here; they exit the system via the fulfillment dispatch flow. `put-away-batch` also rejects these UPCs at the API level if included.

- **To be Removed** (`creditNoteRef` set) — UPCs reserved for credit note removal. Search bar at top (by CN number, UPC ID, or product SKU). UPCs grouped by Credit Note (each group shows CN number, UPC count, product count, date). "Select CN" button per group toggles all UPCs in that CN. "Select All" and "Dispatch (N)" buttons in the toolbar. Dispatch button calls `POST /api/business/credit-notes/dispatch-upcs` directly — **no location dialog**, no shelf assignment needed. Max 100 UPCs per dispatch (enforced in both UI and API). On success: UPCs are set to `putAway: null` and disappear from this tab.

Selection is capped at 100 UPCs across all inbound and outbound sub-tabs (enforced via toast on overflow).

**Dispatched Tab:** Shows all `putAway === null` UPCs (dispatched orders). Rose Package icon per row with order info + dispatch time.

**Location Selector Dialog (`LocationSelectorDialog`):**
- Opened when user clicks "Put Away (N)" from any inbound list.
- Shows "Select Put Away Location" with count of selected UPCs.
- Four sequential dropdowns: Warehouse → Zone → Rack → Shelf. Each subsequent dropdown is disabled until parent is selected. Each fetches its children lazily on first render.
- "Confirm Location" button (disabled until all 4 selected) → calls `POST /api/business/warehouse/put-away-batch` → on success: invalidates putAway queries and shows toast.

---

### Credit Notes
**URL:** `/business/{businessId}/warehouse/credit-notes`

**Wraps in:** Warehouse layout

**APIs used:**
- Firestore `onSnapshot` on `users/{businessId}/credit_notes` (ordered by `createdAt desc`) — real-time list.
- Firestore `getDocs` on `users/{businessId}/parties` (filtered to `type in ['supplier', 'both']`, `isActive: true`) — for party selector in creation dialog.
- Warehouse tree APIs: `GET /api/business/warehouse/list-warehouses`, `list-zones`, `list-racks`, `list-shelves` — for UPC picker in Step 2.
- Firestore `getDocs` on `users/{businessId}/upcs` (filtered to `putAway: 'none'`, `shelfId: selectedShelf.id`) — UPCs available to include in a CN.
- `POST /api/business/credit-notes/complete` — unified create + complete.
- `POST /api/business/warehouse/credit-notes/download-bill` → PDF download.

**Page layout:** `p-6`.

**Header:** "Credit Notes" h1 + description. "+ New Credit Note" button opens the creation dialog.

**List table:** CN Number, Party, Reason, Items (count), Total Value (₹), Status badge (always "completed"), Date. Each row has a Download icon button → `POST /api/business/warehouse/credit-notes/download-bill` → PDF download. Shows "Generating PDF…" toast while loading, "PDF Downloaded" on success.

**Creation Dialog (3-step, inline — no separate page):**

**Step 1 — Party:** Select supplier party from dropdown (suppliers/both, active only). Select reason (Damaged / Quality Rejection / Excess Stock / Expired / Wrong Item Received / Other). Optional notes textarea.

**Step 2 — Items:** Two-panel layout.
- **Left panel — Warehouse tree:** Expandable Warehouse → Zone → Rack → Shelf. Lazy-loaded at each level (click to expand, fetches children on first open). Selected shelf highlighted with blue left-border.
- **Right panel — Shelf UPCs:** Shows all `putAway: 'none'` UPCs on the selected shelf, sorted by `createdAt` ascending, grouped by `productId`. Click a UPC row to toggle selection (checkbox). Selected UPCs tracked in `draftItems` state keyed by `productId`. Summary pill: "N UPCs selected across M products".

**Step 3 — Confirm:** Summary of party and reason. Per-product price input: unit price (ex-tax, required, must be > 0). Total value preview. "Confirm & Complete" button calls `POST /api/business/credit-notes/complete` — on success, dialog closes and list refreshes via the existing `onSnapshot`.

**No draft state** — Credit Notes are created and completed atomically. There is no cancel or edit action on the list.

**Download Bill PDF:**
- Opposite of GRN bill: "Billed By" = Business (issuing the credit note), "Billed To" = Party/Supplier.
- Bank details shown are the **business's bank** (so supplier knows where to send the refund).
- Amber color scheme (vs purple for GRN bills).
- Tax rates read directly from `CreditNoteItem.taxRate` — no product fetch needed.

**Logical connections:**
- Credit Notes created here cause UPCs to appear in Put Away → Outbound → "To be Removed" sub-tab.
- Dispatching UPCs from the put-away page finalises the stock deduction (`inventory.deduction++`).
- The CN's `totalValue` and items feed the **Credit Notes row** in the Gross Profit Report on the Dashboard.

---

### Party Master
**URL:** `/business/{businessId}/warehouse/party-master`

**Wraps in:** Warehouse layout

**APIs used:**
- Firestore `getDocs` on `users/{businessId}/parties` (ordered by `createdAt desc`) via `useParties` (TanStack Query).
- `POST /api/business/warehouse/party/create`
- `POST /api/business/warehouse/party/update`
- `POST /api/business/warehouse/party/delete` (soft-deactivate)

**Page layout:** `min-h-full p-6 space-y-6`.

**Header:** "Party Master" h1 + description. Buttons: Refresh + "Add Party" (Plus).

**Stats (5 cards):** Total, Active (emerald), Inactive (red), Suppliers (blue), Customers (violet).

**Filters Card:** Search (name/code/contact/GSTIN/phone/email) + Type filter (All/Supplier/Customer/Both) + Status filter (All/Active/Inactive) + Sort order Select.

**Table:**
- Columns: Name (+ email below), Code (monospace), Type badge, Contact person, Phone, GSTIN (monospace), Status badge (green CheckCircle2 "Active" / red XCircle "Inactive"), Created date, Actions.
- Inactive rows: `opacity-60`.
- Clicking row → `PartyDetailDialog`.
- Actions: View Details, Edit, separator, Deactivate (active → opens confirmation AlertDialog) / Reactivate (inactive → calls update with `isActive: true` directly).

**Deactivate AlertDialog:** Warns that party won't appear in dropdowns. Blocked if open POs exist (API returns 409 with open PO numbers). Note that this is a soft-delete — data remains.

**PartyFormDialog (Create/Edit):**
- `sm:max-w-2xl`, uses **4 Tabs**: Basic / Address / Tax & Legal / Banking.
- **Basic tab:** Party Name (required), Type (required, Select — locked/disabled on edit with "(locked)" note), Code, Contact Person, Phone, Email, Payment Terms.
- **Address tab:** Line 1, Line 2, City, State, Pincode, Country (default "India").
- **Tax & Legal tab:** GSTIN (15 chars, toUpperCase) + note, PAN (10 chars, toUpperCase) + note.
- **Banking tab:** Account Holder Name, Bank Name, Account Number, IFSC Code.
- Notes textarea (always visible below tabs).
- "Create Party" / "Save Changes" footer button.
- On edit: type field disabled. API call uses `partyId` + fields to update (type never sent on update).

**PartyDetailDialog:**
- Sections with dividers: Identity (code, created date, payment terms), Contact (person, phone+copy, email+copy), Address (formatted single string on muted bg), Tax & Legal (GSTIN+copy, PAN+copy), Bank Details (bank name, account holder, account number+copy, IFSC+copy), Notes.
- Copy buttons: small clipboard icon next to copyable fields, triggers `navigator.clipboard.writeText()` + toast "Copied to clipboard!"

**Logical connections:**
- Parties marked as supplier/both appear in the PO creation form as selectable suppliers.
- Deactivating a party is blocked by the API if open POs reference it.
- Bank details from parties appear in GRN bill PDFs (generated by `grns/download-bill`).

---

### Business Products (Warehouse)
**URL:** `/business/{businessId}/warehouse/products`

**Wraps in:** Warehouse layout

**APIs used:**
- Firestore `onSnapshot` on `users/{businessId}/products` — real-time product list.
- `POST /api/business/products/create`
- `POST /api/business/products/update`
- `POST /api/business/products/delete`
- `POST /api/business/products/bulk-upload` — via BulkUploadDialog (Excel/CSV).
- `POST /api/business/products/bulk-remove-all-mappings` — for selected or all products.
- `POST /api/business/products/logs` — fetches audit trail for a product.
- `POST /api/shopify/products/create-mapping` (via ProductMappingsDialog)
- `POST /api/shopify/products/remove-mapping` (via ProductMappingsDialog)
- `POST /api/shopify/products/bulk-mapping` (via ProductMappingsDialog)
- `POST /api/shopify/products/store-variants` (via ProductMappingsDialog)
- `POST /api/shopify/products/export-store-variants` (via ProductMappingsDialog)

**Page layout:** Full-height flex column (sticky header, scrollable content).

**Header:**
- Left: Primary icon box + "Products" h1 + subtitle.
- Right: "Bulk Upload" button (Upload → opens BulkUploadDialog), "Product Mappings" button (Link2 icon + mapped count badge → opens ProductMappingsDialog), "Add Product" button (Plus, shadow-lg).

**Selection Action Bar (AnimatePresence, shown when products selected):**
- "{N} selected" badge + "Clear selection" button.
- "Remove Mappings" button (Unlink icon, destructive variant, with count badge of selected mappings) → opens Remove Mappings Dialog.

**Stats row (4 gradient cards):** Total Products (blue), Categories count (emerald), Avg Weight in grams (amber), Mapped count (violet, Link2 icon).

**Main Card:**
- **Filter row:** Search (name/SKU/HSN/category, debounced 300ms) + Category filter Select (auto-populated from existing categories with count).
- **Table (AnimatePresence staggered motion.tr rows):**
  - Header: Checkbox (select all visible page), Product (sortable), SKU (sortable), Category (sortable), HSN / Tax, Weight (sortable), Added (sortable, by createdAt).
  - Columns: Checkbox, Product (Package icon in gradient bg + name + mapped count Badge if mapped + description truncated), SKU (code monospace badge), Category (Badge secondary), HSN code (monospace) + Tax rate % below, Weight (N g), Date added.
  - Clicking row does nothing (no detail dialog) — use the MoreHorizontal dropdown.
  - MoreHorizontal (opacity-0 → group-hover:opacity-100): Edit, View History (History icon → opens ProductActivityLog sheet), separator, Delete (destructive).
- **Pagination footer:** same pattern.

**Add/Edit Dialog (`sm:max-w-[520px]`, scrollable):**
- PackagePlus icon in header.
- Fields: Product Name (required), SKU (required, toUpperCase, **disabled on edit**), Weight in grams (required, >0), Category (Select from existing categories — no "create new" here), HSN Code (required, toUpperCase), GST Rate % (Select: 0/5/12/18/28, required), Description (optional), Price ₹ (optional), Stock (optional — sets `openingStock`).
- Validation shown inline below each field.
- "Add Product" / "Save Changes" footer.
- On update: diff detection via `getChanges()` server-side — only changed fields logged. Toast shows changed field names.

**Remove Mappings Dialog:**
- Two options with separate buttons: "Remove" for selected products (shows selected count + mapping count), "Remove All" for all mapped products (shows total counts).
- Warning card (amber AlertTriangle): explains this unlinks store variants.

**ProductActivityLog (Sheet component):** Shows chronological audit log for a specific product's field changes, with old→new values formatted.

**ProductMappingsDialog:** Full-featured variant mapping manager. Shows all store variants across all linked stores, with their mapped business product. Create/remove individual mappings. Bulk mapping via Excel upload. Export store variants to Excel.

**BulkUploadDialog:** Accepts Excel/CSV. Two modes: `add` (creates new products, skips existing SKUs) and `update` (updates existing products, skips non-existing). Returns result Excel with Status/Message per row.

**Logical connections:**
- Products created here are the foundation for UPC tracking, inventory management, warehouse placements, GRN receiving, and Shopify variant mapping.
- The SKU is the document ID and is immutable — it's used everywhere as the primary identifier.
- Mapped variants (from ProductMappingsDialog) enable the inventory blocking system and Shopify sync.
- HSN code and tax rate drive GST calculations in GRN bill PDFs.

---

### Activity Logs
**URL:** `/business/{businessId}/warehouse/logs`

**Wraps in:** Warehouse layout

**APIs used:**
- `GET /api/business/warehouse/list-logs?businessId=&entityType=&limit=100` — fetches recent activity logs.

**Page layout:** `min-h-full p-6 space-y-6`.

**Header:** "Activity Logs" h1 + "Complete audit trail of all warehouse changes".

**Main Card:**
- **Header:** History icon + "Recent Activity" title + "Changes to zones, racks, shelves, and placements" description. Right: Entity type filter Select (All/Zones/Racks/Shelves) + Refresh button (RefreshCw, spins while loading).
- **Content:** Loading skeletons → empty state (History icon "No activity logs") → grouped list.
- **Date grouping:** Logs grouped by date with divider line + "Today" / "Yesterday" / "Monday, 20 January 2025" labels.
- **`LogItem` component (Collapsible):**
  - Collapsed: Entity type icon (MapPin=zone emerald, Grid3X3=rack amber, Layers=shelf purple, Package=placement violet) + entity name + Entity type badge + Action badge (Created=emerald Plus, Updated=blue Pencil, Deleted=rose Trash, Restored=amber RotateCcw, Moved=purple MoveRight, Adjusted=blue Pencil). Quick summary text (e.g. "Moved from Zone A to Zone B", "3 field(s) changed"). Timestamp (date + time). ChevronDown if has details.
  - Expanded (CollapsibleContent): muted background. Move details (badge → arrow → badge). Quantity change (code → arrow → code with +/− colored delta). Field changes (list of monospace `fieldName: oldValue → newValue`). User ID footer.

---

### Movements
**URL:** `/business/{businessId}/warehouse/movements`

**Wraps in:** Warehouse layout

**APIs used:**
- `GET /api/business/warehouse/list-movements?businessId=&type=&productId=&startAfter=` — paginated (50 per page).

**Page layout:** `min-h-full p-6 space-y-6`.

**Header:** "Stock Movements" h1 + description.

**Stats (4 cards, clickable to filter):** Inbound (emerald), Outbound (rose), Transfer (blue), Adjustment (amber). Values computed from loaded movements.

**Main Card:**
- **Header:** ArrowLeftRight icon + "Movement History" title. Right: Search input (by productId/SKU, Enter to search) + X clear button + Type filter Select (All/Inbound/Outbound/Transfer/Adjustment) + Refresh button.
- **Content:** Loading skeletons → empty state (ArrowLeftRight icon) → Table.
- **Table columns:** Type (colored Badge), Product (Package icon + SKU monospace), From location, → arrow, To location, Quantity (colored: +green for inbound, -red for outbound/negative adjustment), Reason (truncated text), Time (Calendar icon + "20 Jan, 14:30" format).
- **Load More button** at bottom when `hasMore === true` (pagination via `startAfter` cursor).
- Clear search: resets `lastId` and re-fetches.

**Location display:** `formatLocation()` function joins `zoneId > rackId > shelfId` — shows "—" if no shelfId.

---

## B2B (Manufacturing / Production)

> **Note: B2B frontend source files were not provided. The descriptions below are preserved from the original route map.**

| Page | URL | Description |
|---|---|---|
| Orders List | `/business/{businessId}/b2b/orders` | All B2B manufacturing orders. Status: DRAFT / IN_PRODUCTION / CONFIRMED / CANCELLED / COMPLETED. |
| Create Order | `/business/{businessId}/b2b/orders/create` | Create a new B2B order (with or without a draft). |
| Order Detail | `/business/{businessId}/b2b/orders/{orderId}` | View a specific B2B order's details, total lots, quantities, completion status. |
| Edit Order | `/business/{businessId}/b2b/orders/{orderId}/edit` | Edit a DRAFT B2B order (buyer, ship date, lots). |
| Lots List | `/business/{businessId}/b2b/lots` | All production lots across all stages. |
| Lot Detail | `/business/{businessId}/b2b/lots/{lotId}` | View a specific lot's stage-by-stage progress, delay status, BOM consumption, and full history. |
| Kanban | `/business/{businessId}/b2b/kanban` | Visual drag-and-drop kanban of lots across all configured production stages. |
| Products | `/business/{businessId}/b2b/products` | B2B product catalogue (manufacturing products, not Shopify products). SKU is the doc ID. |
| Product Detail | `/business/{businessId}/b2b/products/{productId}` | View/edit product details including associated BOM structure. |
| BOM | `/business/{businessId}/b2b/bom` | Bill of Materials — defines raw materials + quantities + wastage% consumed per product unit, organized by production stage. One active BOM per product at a time. |
| Buyers | `/business/{businessId}/b2b/buyers` | Directory of B2B buyers/customers with contact, GST, address. |
| Stages | `/business/{businessId}/b2b/stages` | Configure named production stages (label, defaultDurationDays, canBeOutsourced, sortOrder). Stage `name` is immutable once created (referenced on every lot). |
| Raw Material Stock | `/business/{businessId}/b2b/stock` | Raw material inventory. availableStock always equals totalStock (no reservation system). Reorder level alerts. |
| Material Detail | `/business/{businessId}/b2b/stock/{materialId}` | View a specific raw material's transaction history, current stock, and details. |
| Dispatch | `/business/{businessId}/b2b/dispatch` | Record dispatch of finished goods from completed lots (AWB, courier name, carton count, weight). |
| Dispatch History | `/business/{businessId}/b2b/dispatch/history` | Full history of all finished good dispatches. |

---

## API ROUTES

### Agent Chat Session

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/agent/session/create` | Creates a new agent chat session. Always creates a fresh session (no reuse of old ones). Writes to `users/{businessId}/agent_sessions/{sessionId}` with `status: 'idle'`, `generatingStartedAt: null`, `endedAt: null`. Returns `{sessionId, isNew: true}`. |
| POST | `/api/business/agent/session/end` | Marks session as ended. Updates `status: 'ended'`, `endedAt: Timestamp.now()`. Idempotent — returns 200 if session not found or already ended. Called via keepalive fetch on page unload and on layout unmount. |

---

### Business Auth & Listing

| Method | Route | Description |
|---|---|---|
| GET | `/api/business/list` | Returns all businesses the current user belongs to. Fetches user's own businessId + all IDs in `userData.businesses`. For each: fetches business name from `primaryContact.name` or `profile.displayName`, counts members subcollection (+1 for owner). Sorted: own business first, then alphabetically by name. Returns `[{businessId, businessName, memberCount, isOwnBusiness}]`. |
| GET | `/api/business/[businessId]/auth` | Full auth check for a specific business. Verifies Bearer token, checks user is owner OR active member. Returns: `{authorized, businessId, userIsBusiness, member: {id, permissions}, stores[], joinedBusinesses: [{id, name, currentlySelected}], vendorName, currentUserId}`. `joinedBusinesses` lists all businesses the current user is part of (own + via `businesses` array). Used on business switch to build the switcher dropdown. |
| POST | `/api/auth/set-business-claims` | Sets Firebase custom token claims after business switch. Auth-guards via `authUserForBusiness`. Computes `accessibleStores` = union of user's own `stores` array + stores from all businesses where user is an active member. Writes claims: `{businessId, accessibleStores, vendorName}`. These claims are used by Firestore security rules and Cloud Functions to authorize data access. |

---

### Dashboard Orders (Shopify)

| Method | Route | Description |
|---|---|---|
| POST | `/api/shopify/orders/bulk-update-status` | Updates status on one or more orders in a Firestore transaction. Allowed target statuses: `Confirmed`, `Closed`, `RTO Closed`, `Lost`. Appends a log entry to `customStatusesLogs` with a hardcoded remark per status. On shared stores: validates vendor auth per order, skips unauthorized orders. **For Confirmed:** on shared stores with multi-vendor orders (vendors.length > 1 + specific vendor names), enqueues an order-split Cloud Task first; those orders are skipped from the status update. **For RTO Closed:** queries `users/{businessId}/upcs` where `orderId == orderId`. Updates found UPCs to `putAway: 'inbound'`. If no UPCs found, creates new UPC docs (one per line item × quantity) with `putAway: 'inbound'`, resolving businessId and productSku via `accounts/{storeId}/products/{productId}.variantMappingDetails[variantId]`. Returns detailed summary: ordersUpdated, ordersSplit, upcsUpdated, upcsCreated. |
| POST | `/api/shopify/orders/update-status` | Same as bulk-update-status but for a single order. Allowed statuses: `Confirmed`, `Closed`, `RTO Closed`. Uses Firestore transaction. Vendor auth check on shared stores. |
| POST | `/api/shopify/orders/dispatch` | Calls `ENQUEUE_FUNCTION_URL_2` Cloud Function with `{businessId, shop, orderIds, requestedBy}`. Cloud Function creates Cloud Tasks that mark orders as `Dispatched` and dispatches their UPCs (putAway: outbound → dispatched). Returns 202. |
| POST | `/api/shopify/orders/mark-packed` | Guards: order must be in `Ready To Dispatch` status (not any other). Records the packing video: appends `{packingVidUrl, packedAt: Timestamp}` to `order.packingVidUrls` array. Sets `order.lastPackedAt`. Does NOT change `customStatus`. |
| POST | `/api/shopify/orders/make-pickup-ready` | Assigns specific UPC IDs to a Confirmed order. Resolves correct `businessId` per UPC by walking order line items → `accounts/{storeId}/products/{productId}.variantMappingDetails[variantId].businessId` → searching for each UPC in `users/{actualBusinessId}/upcs/{upcId}`. Batch-updates found UPCs to `{storeId, orderId, putAway: 'outbound'}`. Updates order to `{pickupReady: true, pickupReadyAt}`. Does NOT change `customStatus` (that is done by the AWB assignment batch when AWB is actually assigned). |
| POST | `/api/shopify/orders/revert-to-confirmed` | Reverts a Ready To Dispatch order back to Confirmed. Finds the first `Confirmed` entry in `customStatusesLogs` (sorted ascending by createdAt). Trims the log array to include only up to that entry. Deletes `awb`, `courier`, `courierProvider` fields from the order doc via `FieldValue.delete()`. The `updateOrderCounts` trigger then detects the status change and syncs `{status}At` fields + `lastStatusUpdate` from the trimmed log — this also deletes the now-orphaned `readyToDispatchAt` field. Returns 422 if no Confirmed log found. |
| POST | `/api/shopify/orders/revert-to-delivered` | Reverts a DTO Requested or DTO Booked order back to Delivered. Finds first `Delivered` log entry, trims log to that point. Deletes `awb_reverse`, `courier_reverse`, `courierReverseProvider` fields. The `updateOrderCounts` trigger then syncs `{status}At` fields + `lastStatusUpdate` from the trimmed log — deleting orphaned fields like `dtoRequestedAt` or `dtoBookedAt`. Returns 422 if no Delivered log found. |
| POST | `/api/shopify/orders/split-order` | Calls `ENQUEUE_ORDER_SPLIT_FUNCTION_URL` Cloud Function with `{shop, orderId, requestedBy}`. Cloud Function creates a Shopify draft order per vendor, allocates proportional discounts and payments. Returns 202. |
| POST | `/api/shopify/orders/refund` | Processes refund for a Pending Refunds order. Requires `itemRefundAmounts` map (`{[variantId or itemId]: refundAmount}`) — all line items must have an entry, returns 400 otherwise. Updates each `raw.line_items[].refundedAmount` with the per-item amount. **store_credit method:** calls Shopify GraphQL `storeCreditAccountCredit` mutation with total refundAmount. **manually paid:** skips Shopify call. Sets `customStatus: 'DTO Refunded'`, appends log entry. For store_credit: sends WhatsApp message to customer. |
| POST | `/api/shopify/orders/delete` | Calls Shopify REST API `DELETE /admin/api/2024-07/orders/{orderId}.json`. Firestore deletion is handled by the `orders/delete` webhook. Returns 200 if Shopify responds 200 or 404. |
| POST | `/api/shopify/orders/export` | Fetches selected orders in chunks of 30 (Firestore `in` query limit). One Excel row per line item. On shared stores: filters by vendor auth. Per-item columns include: orderName, isPickedUp, AWB, returnAWB, courier, orderDate, lastStatusUpdate, customer, email, phone, itemTitle, itemSku, returnRequested, itemQty, itemPrice (less discounts), proportionate totalPrice, proportionate totalOutstanding, discount, vendor, currency, paymentStatus (Prepaid/COD), status, billing address fields, shipping address fields. |
| POST | `/api/shopify/orders/download-slips` | Puppeteer PDF (A4) with one page per order. Shows: courier name (header), AWB as CODE128 barcode (JsBarcode), ship-to name + address + PIN, phone (masked for Blue Dart: `X{digits}XXXXX{last3}`). Blue Dart only: shows `bdDestinationArea` and `bdClusterCode` next to PIN, mode forced to "Express". Payment info: Prepaid/COD, total price, **Collectable Amount** (from `raw.total_outstanding`) in numbers and words (Indian numeral system). Seller name, GST (03AAQCM9385B1Z8). Product table: HSN, qty, taxable price (total / 1.05), taxes (5%), total. Return address from `businessData.companyAddress`. |
| POST | `/api/shopify/orders/generate-purchase-order` | Generates a compact A4 PDF purchase order for a single vendor. Aggregates all line items matching `item.vendor === vendor` across selected orders, groups by SKU. Columns: Sr No, Item SKU, Qty. Shows PO number format `{vendor}-{poNumber}`, date, total pcs. |
| POST | `/api/shopify/orders/update-confirmed-orders-availability-tag` | Tags a Confirmed order's availability. Writes to `tags_confirmed` as an array keeping only the last 2 entries (new tag at front, old entries shifted by slice(1)). Used by the Availability Dialog to mark each order as Available / Unavailable / Pending. |
| POST | `/api/shopify/orders/export-products` | Exports a products list Excel from selected orders. One row per line item: srNo, itemSku, itemQty, vendor, orderName, availability (blank — to be filled manually). On shared stores: vendor auth applied. |
| POST | `/api/shopify/orders/qc-test` | Only for `DTO In Transit` or `DTO Delivered` orders. Requires `qcStatuses` object keyed by line item ID (ALL items must have a non-empty string status — returns 400 otherwise). Verifies `videoPath` file exists in Firebase Storage bucket. Updates `raw.line_items[].qc_status` per item. Sets `unboxing_video_path`, moves order to `Pending Refunds`. **For QC Pass items:** resolves `businessId` and `businessProductSku` via variant mapping. Searches for existing UPCs by `orderId` + `productId`; if found, updates `putAway: 'inbound'`; if not, creates new UPCs (`putAway: 'inbound'`, one per quantity). UPCs appear in Put Away → Inbound → DTO Returns. |

---

### Courier / AWB

| Method | Route | Description |
|---|---|---|
| POST | `/api/shopify/courier/assign-awb` | Calls `ENQUEUE_FUNCTION_URL` Cloud Function with `{businessId, shop, orders, courier, pickupName, shippingMode, requestedBy}`. `orders` is an array of `{orderId, name}`. Validates shared-store auth (non-super-admin businesses cannot use shared stores here). Supported couriers: Delhivery, Shiprocket, Xpressbees, Blue Dart, Priority. Cloud Function creates one Cloud Task per order. Returns 202 with batch info. |
| POST | `/api/shopify/courier/fetch-awbs` | Fetches `count` new AWBs (1–500) from Delhivery's bulk AWB endpoint (`/waybill/api/bulk/json/?count={count}`). Parses comma-separated response. Uses `db.bulkWriter()` to insert into `users/{businessId}/unused_awbs/{awb}` docs with `create()` (skips duplicates on error code 6/already-exists). Returns `{awbs[], requested, count, added, duplicates}`. |
| POST | `/api/shopify/courier/book-reverse-order` | Books a single-order return shipment. Guards: `customStatus` must be `Delivered` or `DTO Requested`. Allocates an AWB from `users/{businessId}/unused_awbs` via Firestore transaction (pops first doc). Builds Delhivery reverse payload: consignee = customer address, `payment_mode: 'Pickup'`, `pickup_location.name = 'Majime Productions 2'` (hardcoded). Products list from selected line items (filtered by `variant_ids_of_selected_line_items_to_be_returned`). Posts to Delhivery create-shipment API. On carrier failure: releases AWB back to pool via `releaseAwb()`. On success: sets `{awb_reverse, customStatus: 'DTO Booked', courier_reverse: 'Delhivery', courierReverseProvider: 'Delhivery'}`, appends log, sends WhatsApp notification. |
| POST | `/api/shopify/courier/bulk-book-return` | Calls `ENQUEUE_RETURN_FUNCTION_URL` Cloud Function with `{businessId, shop, orderIds, shippingMode, requestedBy}`. Courier is read from each order's `courier` field inside the Cloud Function (not specified here). Returns 202. |
| POST | `/api/shopify/courier/update-shipped-statuses` | **Disabled.** Returns 500 with `{error: 'API shut down for the moment.'}`. Do not call. |
| POST | `/api/shopify/courier/download-jobs` | Downloads an Excel file of jobs from a specific batch (from `users/{businessId}/{collectionName}/{batchId}/jobs`). `status` param must be `success` or `failed`. If batch `courier === 'Priority'`, adds a Courier column showing per-job courier. For failed: adds Error Reason column. For success with `errorMessage` field: adds Remarks column. Header row bold. Returns `.xlsx` binary. |

---

### B2B Orders & Lots

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/b2b/create-order` | Creates a B2B order directly in `IN_PRODUCTION` status (no DRAFT). Requires: businessId, buyerId, buyerName, buyerContact, shipDate (ISO string), deliveryAddress, createdBy, lots (non-empty array). Validates: buyer exists and isActive, stages configured (must have ≥1 stage in `production_stage_config`), each lot has productId + qty > 0 + stages (validated against configured stage names), product exists and isActive, optional bomId exists if provided. Generates `orderNumber` (counter-based). Calls `buildLots()` to create lot documents. Batch-writes order + all lots. Lot status starts at `ACTIVE`, first stage `IN_PROGRESS`. |
| POST | `/api/business/b2b/save-draft-order` | Creates a B2B order in `DRAFT` status. Same validations as create-order EXCEPT BOM validation is deferred (a draft may be saved before BOM is set up). Lots stored in `order.draftLots` (not as separate lot docs — those are only created on confirm). |
| POST | `/api/business/b2b/update-draft-order` | Updates a DRAFT order's buyer, dates, delivery address, and draftLots. Guards: order must be `DRAFT` status. Validates buyer (active) and products/stages (BOM deferred). Replaces `draftLots` entirely. |
| POST | `/api/business/b2b/confirm-order` | Transitions a DRAFT order to IN_PRODUCTION. Validates buyer (active), all lots (qty > 0, stages valid, products active, bomId if provided). Caller can pass `lots` to override the `order.draftLots` at confirm time. Creates lot documents (via `buildLots()`). Updates order: `{status: 'IN_PRODUCTION', draftLots: null, totalLots, totalQuantity, lotsInProduction}`. |
| POST | `/api/business/b2b/cancel-order` | Cancels a B2B order. Guards: cannot cancel already CANCELLED order. DRAFT orders: just flips order status to CANCELLED, no lots to cancel. IN_PRODUCTION orders: also cancels all non-terminal lots (status not in CANCELLED/COMPLETED) via batch write. Returns `{success, lotsCancelled}`. |
| POST | `/api/business/b2b/advance-lot-stage` | Advances a lot's current stage to the next. Guards: lot must be ACTIVE; current stage must not be BLOCKED. Marks current stage `COMPLETED` (sets actualDate, completedBy, note). Marks next stage `IN_PROGRESS`. If this is the last stage, marks lot `COMPLETED` and status `COMPLETED`. Recalculates `isDelayed` and `delayDays` (via `computeDelayStatus()`). Transaction-wrapped. |
| POST | `/api/business/b2b/set-lot-stage-blocked` | Toggles the current stage of a lot as BLOCKED or IN_PROGRESS. Guards: lot must be ACTIVE; idempotency checks (already BLOCKED → 400, already IN_PROGRESS → 400). Accepts optional `reason` stored as stage `note`. |
| POST | `/api/business/b2b/cancel-lot` | Cancels a single lot. Guards: cannot cancel CANCELLED or COMPLETED lots. Sets `{status: 'CANCELLED', isDelayed: false, delayDays: 0}`. |
| POST | `/api/business/b2b/dispatch-finished-good` | Records dispatch of a finished lot as a finished good. Required: finishedGoodId, courierName, awb, dispatchedBy. Optional: cartonCount, totalWeightKg. Guards: `already_dispatched` if `isDispatched = true`. Sets `{isDispatched: true, dispatchedAt, courierName, awb}`. |
| POST | `/api/business/b2b/get-order-dashboard` | Fetches B2B order dashboard data: order doc, all lots for that order (grouped by `currentStage`), TNA (Time & Action) summary per lot (currentStage, isDelayed, delayDays, per-stage plannedDate/actualDate/status), totals (totalLots, lotsDelayed). |

---

### B2B Products, BOM & Raw Materials

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/b2b/create-product` | Creates a B2B product. `productId = SKU.trim().toUpperCase()` (used as document ID). Validates all `defaultStages` against configured stage names (`production_stage_config`). Guards: duplicate SKU returns 400. Fields: name, sku, category, description (optional), defaultStages array, isActive=true. |
| POST | `/api/business/b2b/update-product` | Updates any fields except `sku` (immutable — it's the doc ID and referenced in lots/BOM). If `defaultStages` provided, validates all stage names against configured stages. Applies only fields explicitly present in the body. |
| POST | `/api/business/b2b/create-bom-entry` | Creates a full BOM for a product. Guards: only one active BOM per product (returns `bom_already_exists` if one exists). Validates: product exists and isActive, all stage names configured, each stage has ≥1 material, each material exists and isActive, `quantityPerPiece > 0`, `wastagePercent` 0–100. Fetches and denormalizes `materialName`, `materialUnit` into each BOMStageItem. |
| POST | `/api/business/b2b/update-bom-entry` | Replaces the stages array of an existing active BOM entirely. Cannot change the linked product. Guards: BOM must exist and `isActive=true`. Same stage/material validations as create. |
| POST | `/api/business/b2b/deactivate-bom-entry` | Soft-deactivates a BOM entry by setting `isActive: false`. Guards: BOM must exist and be active. |
| POST | `/api/business/b2b/create-raw-material` | Creates a raw material. `materialId = SKU.trim().toUpperCase()` (document ID). Guards: duplicate SKU → 400. `reorderLevel` must be ≥ 0. Fields: name, sku, unit, category, reorderLevel, supplierName (optional). Initial stock: totalStock=0, availableStock=0 (no reservation system — these two are always equal). |
| POST | `/api/business/b2b/update-raw-material` | Updates any raw material fields except `totalStock` and `availableStock` (those are managed by add-stock/adjust-stock only — returns `stock_fields_not_allowed` if attempted). If `reorderLevel` provided, validates ≥ 0. |
| POST | `/api/business/b2b/add-stock` | Adds positive stock to a raw material. Guards: material must exist and isActive; quantity must be > 0. Firestore transaction: reads current stocks, increments totalStock and availableStock (both equal, no reservation). Creates a `PURCHASE` type `MaterialTransaction` doc in `users/{businessId}/material_transactions`. Requires: businessId, materialId, quantity, referenceId (PO or invoice number), createdBy. |
| POST | `/api/business/b2b/adjust-stock` | Adjusts raw material stock by a positive or negative delta. Guards: quantity cannot be 0; adjustment cannot bring totalStock below zero (returns `adjustment_exceeds_stock`); material must be active. Firestore transaction: increments totalStock and availableStock by quantity. Creates an `ADJUSTMENT` type `MaterialTransaction` doc. Note field required. |

---

### B2B Buyers & Stage Config

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/b2b/create-buyer` | Creates a buyer. Required: businessId, name, contactPerson, phone, email, address, createdBy. Optional: gstNumber. |
| POST | `/api/business/b2b/update-buyer` | Updates any provided fields on a buyer. No field-level validation beyond existence check. |
| POST | `/api/business/b2b/create-stage-config` | Creates a named production stage. Guards: stage `name` must be unique per business (`stage_name_already_exists`). Required: name (StageName type), label, description, defaultDurationDays, canBeOutsourced (bool), sortOrder (int). Stage `name` is immutable after creation (referenced as string on every lot). |
| POST | `/api/business/b2b/update-stage-config` | Updates a stage config. Guards: `name` cannot be updated (returns `name_not_updatable`). Validates `defaultDurationDays > 0` and `sortOrder >= 1` if provided. |

---

### Warehouse — Structure CRUD

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/warehouse/create-warehouse` | Creates a warehouse. `code.trim().toUpperCase()` becomes the document ID. Guards: duplicate code with `isDeleted=false` returns 409. If code exists with `isDeleted=true`, restores it (re-activates). |
| PUT | `/api/business/warehouse/update-warehouse` | Updates warehouse name and/or address. Code (doc ID) is not updatable. |
| DELETE | `/api/business/warehouse/delete-warehouse` | Soft-deletes (sets `isDeleted=true`, `deletedAt`). Guards: cannot delete if any active zones exist (`where('warehouseId','==',warehouseId).where('isDeleted','==',false).limit(1)`). |
| POST | `/api/business/warehouse/create-zone` | Creates a zone inside a warehouse. Same code-as-ID pattern. Checks for duplicate non-deleted code. `description` optional. |
| PUT | `/api/business/warehouse/update-zone` | Updates zone name and/or description. Code (doc ID) not updatable. |
| DELETE | `/api/business/warehouse/delete-zone` | Soft-delete. Guards: no active racks in this zone. |
| PUT | `/api/business/warehouse/move-zone` | Moves a zone to a different warehouse. Only updates `zone.warehouseId`. Cloud Functions (`onZoneWritten`) handle stat updates on old/new warehouses and propagate warehouseId to all child racks, shelves, placements. |
| POST | `/api/business/warehouse/create-rack` | Creates a rack inside a zone. Code-as-ID. Position is auto-assigned (max existing position + 1) unless provided, in which case existing racks at or after that position are shifted +1. |
| PUT | `/api/business/warehouse/update-rack` | Updates rack name and/or position. If position changes, rebalances other racks in the same zone (shifts up or down to fill gap). Code not updatable. |
| DELETE | `/api/business/warehouse/delete-rack` | Soft-delete. Guards: no active shelves in this rack. |
| PUT | `/api/business/warehouse/move-rack` | Moves a rack to a different zone. Closes position gap in source zone (shifts others down). Makes room in target zone (shifts others up). If `targetPosition` not provided, appends at end. Cloud Functions (`onRackWritten`) handle stats and propagate location to shelves/placements. |
| POST | `/api/business/warehouse/create-shelf` | Creates a shelf inside a rack. Same position management as rack (auto or provided, with sibling shifting). |
| PUT | `/api/business/warehouse/update-shelf` | Updates name, position, and/or capacity. Position rebalancing within the rack. |
| DELETE | `/api/business/warehouse/delete-shelf` | Soft-delete. Guards: no placements exist for this shelf (`where('shelfId','==',shelfId).limit(1)`). |
| PUT | `/api/business/warehouse/move-shelf` | Moves shelf to a different rack. Closes gap in source, makes room in target. Cloud Functions (`onShelfWritten`) propagate location to placements. |
| POST | `/api/business/warehouse/create-instant-warehouse` | Bulk-creates a full warehouse structure in one request: 1 warehouse + N zones × M racks per zone × P shelves per rack. All IDs are nanoid-generated (13-char alphanumeric). Total entities capped at 5000. Executes in multiple Firestore batches (500-write limit each, committed in parallel). Returns structure summary and batchesUsed count. |
| GET | `/api/business/warehouse/list-warehouses` | Lists all non-deleted warehouses (`isDeleted=false`), ordered by name asc. Returns id, name, address, storageCapacity, operationalHours, defaultGSTstate, stats (totalZones/Racks/Shelves/Products). Requires `?businessId=` query param. |
| GET | `/api/business/warehouse/list-zones` | Lists non-deleted zones in a warehouse. Requires `?businessId=&warehouseId=`. Ordered by name asc. |
| GET | `/api/business/warehouse/list-racks` | Lists non-deleted racks in a zone. Requires `?businessId=&zoneId=`. Ordered by position asc. |
| GET | `/api/business/warehouse/list-shelves` | Lists non-deleted shelves in a rack. Requires `?businessId=&rackId=`. Ordered by position asc. |
| GET | `/api/business/warehouse/list-upcs` | Lists UPCs at a placement (i.e. placed on a shelf, `putAway='none'`). Requires `?businessId=&placementId=`. |
| GET | `/api/business/warehouse/list-placements` | Lists all placements on a shelf. Requires `?businessId=&shelfId=`. Returns id, productId, quantity, location fields. |
| GET | `/api/business/warehouse/list-product-placements` | Lists all placements for a specific product that have `quantity > 0`. Requires `?businessId=&productId=`. Returns all shelf locations where this product has stock, with a human-readable `locationPath`. |
| GET | `/api/business/warehouse/list-movements` | Lists stock movement history. Requires `?businessId=`. Filters: `type`, `productId`, `warehouseId` (all optional). Paginated via `?startAfter={movementId}`. Ordered by timestamp desc. |
| GET | `/api/business/warehouse/list-logs` | Lists warehouse audit logs. Requires `?businessId=`. If `entityType` + `entityId` provided, fetches logs from that entity's logs subcollection. Otherwise fetches recent logs from all entities (zones, racks, shelves — last 5 per entity across up to 20 entities of each type). Ordered by timestamp desc. |

---

### Warehouse — GRNs

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/warehouse/grns/create` | Creates a GRN linked to a PO. Validates: PO status must not be draft/closed/cancelled. Bill number must be unique across all GRNs for this business. All SKUs must exist in `users/{businessId}/products`. No duplicate SKUs in items array. Generates GRN number (`GRN-XXXXX`, sequential counter). Computes totals: totalExpectedQty, totalReceivedQty, totalNotReceivedQty, totalReceivedValue. Updates PO's `items[].receivedQty` and recalculates PO status (pending/partially_received/fully_received). GRN starts in `draft` status. |
| POST | `/api/business/warehouse/grns/update` | Updates a GRN's items or status. Status transitions: `draft → completed` or `draft → cancelled`. Terminal states (completed, cancelled) cannot transition further. Only draft GRNs can have items edited. **On cancellation:** reverts PO's `items[].receivedQty` by subtracting the GRN's received quantities, recalculates PO status. |
| POST | `/api/business/warehouse/grns/delete` | Deletes a GRN. Only `cancelled` status GRNs can be deleted. |
| POST | `/api/business/warehouse/grns/confirm-put-away` | Completes a draft GRN by creating individual UPC docs for each received unit. Filters items with `receivedQty > 0`. Creates one UPC per unit (up to 490 per batch, last batch includes the GRN status update). Each UPC starts with `putAway: 'inbound'`, `grnRef: grnId`, no location set. Updates GRN: `{status: 'completed', completedAt, completedBy, totalUPCsCreated}`. Returns detailed item summary. |
| POST | `/api/business/warehouse/grns/download-bill` | Generates a Puppeteer A4 PDF GRN receipt. Auth: verifies Bearer token + checks membership (must be in `users/{businessId}/members/{uid}`). Fetches GRN, linked PO, and supplier party. Fetches `taxRate` for each unique SKU via `db.getAll()` (batch get). Intra/inter-state determination: checks party's `address.state.toLowerCase()` against `'punjab'` or `'pb'`. Intra-state → CGST+SGST; Inter-state → IGST. Falls back to 5% if product taxRate missing. Shows: GRN number, bill number, supplier bank details, receiver GSTIN (03AAQCM9385B1Z8), all received items with per-item GST breakdown, grand total, terms and conditions. |

---

### Warehouse — Credit Notes

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/credit-notes/complete` | Unified create + complete for a Credit Note. No draft state — CN is created and completed in a single atomic operation. **Pre-flight** (outside transaction): `db.getAll()` batch-reads all UPC docs. Validates each is `putAway: 'none'` — returns 400 immediately if any fail, no locks acquired. **Transaction**: increments `users/{businessId}.creditNoteCount` to generate `creditNoteNumber` (CN-001, CN-002…). Creates CN doc with `status: 'completed'` and `completedAt` set immediately. Sets each UPC `putAway → 'outbound'` and tags `creditNoteRef: cnId`. Setting UPCs to `outbound` triggers `onUpcWritten` `none → outbound` branch: decrements `inShelfQuantity` and placement quantity. UPCs appear in Put Away → Outbound → "To be Removed" tab. Body: `{businessId, partyId, partyName, warehouseId, reason, notes, items[], totalItems, totalValue}`. Returns `{id: cnId}` (201). |
| POST | `/api/business/credit-notes/dispatch-upcs` | Physically removes credit note UPCs from inventory by setting `putAway → null`. Called from Put Away → Outbound → "To be Removed" tab Dispatch button. Validates each UPC is `putAway: 'outbound'` AND has `creditNoteRef` set — rejects order-dispatch UPCs (no `creditNoteRef`). Sets each validated UPC `putAway: null`. `onUpcWritten` fires and routes to `inventory.deduction++` (since `creditNoteRef` is present). **Max 100 UPCs per request.** Body: `{businessId, upcIds[]}`. Returns `{success: true, count: N}`. |
| POST | `/api/business/warehouse/credit-notes/download-bill` | Generates a Puppeteer A4 PDF credit note bill. Auth: Bearer token + business membership check. Fetches CN doc and Party doc. **Opposite of GRN bill**: "Billed By" = Business (issuing the CN), "Billed To" = Party/Supplier. Bank details shown are the business's bank (so supplier refunds there). Tax rates come directly from `CreditNoteItem.taxRate` — no product fetch needed (stored at CN creation time). Intra/inter-state determined by party's `address.state` vs Punjab. Amber color scheme. Returns PDF binary (`application/pdf`, `Content-Disposition: attachment`). Body: `{businessId, creditNoteId}`. |

---

### Warehouse — Inward & Put Away

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/warehouse/bulk-inward-products` | Inwars stock from a GRN into warehouse placements. Takes `{businessId, grnId, items[{sku, productName, acceptedQty, unitCost, location: {warehouseId, zoneId, rackId, shelfId}}]}`. Guards: GRN must exist and be `draft`. Each item max 500 units. Validates all SKUs exist in business products. Per item: increments `inventory.inwardAddition`, creates or updates placement doc (`{productId}_{shelfId}`) — toggles `createUPCs` flag on update. Creates audit log on each product. Updates GRN status to `completed`. |
| POST | `/api/business/warehouse/put-away-batch` | Assigns a batch of UPCs (by ID) from `putAway='inbound'` to a specific shelf. Validates warehouse hierarchy: zone must be in warehouse, rack must be in zone, shelf must be in rack. Removes duplicates from upcIds. **Rejects UPCs that are `putAway: 'outbound'` with `creditNoteRef: null`** (order-dispatch UPCs — returns 400 with `{error, blockedUpcs[]}`). Finds each remaining UPC and verifies existence. Batch-updates all UPCs: sets `{warehouseId, zoneId, rackId, shelfId, placementId: '{productId}_{shelfId}', putAway: 'none', orderId: null, storeId: null}`. **Max 100 UPCs per call.** |

---

### Warehouse — Party & Purchase Orders

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/warehouse/party/create` | Creates a supplier/customer/both party. Validates GSTIN (15-char regex: `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$`) and PAN (10-char regex: `^[A-Z]{5}[0-9]{4}[A-Z]{1}$`) if provided. GSTIN uniqueness check across all parties. Stores: name, type, code, contactPerson, phone, email, address, gstin, pan, bankDetails (accountName, accountNumber, ifsc, bankName), defaultPaymentTerms, notes, isActive=true. |
| POST | `/api/business/warehouse/party/update` | Updates any party fields. `type` cannot be changed after creation. GSTIN uniqueness check excludes self. At least one field required (beyond bookkeeping). |
| POST | `/api/business/warehouse/party/delete` | Soft-deactivates a party (sets `isActive: false`). Guards: checks for open POs (`where('supplierPartyId','==',partyId)` excluding statuses closed/cancelled/fully_received). Returns 409 with open PO numbers if any exist. |
| POST | `/api/business/warehouse/purchase-orders/create` | Creates a PO. Validates: supplier party must exist, isActive, and type is 'supplier' or 'both'; warehouse must exist and not be deleted; warehouse name must match stored name; all product SKUs must exist in business products; no duplicate SKUs. Generates PO number (`PO-XXXXX`, sequential counter). Computes totalAmount. Status starts as `draft`. |
| POST | `/api/business/warehouse/purchase-orders/update` | Updates a PO. Status transitions: draft→confirmed/cancelled, confirmed→partially_received/closed/cancelled, partially_received→fully_received/closed. Items can only be edited when status is draft or confirmed. Editing items resets all receivedQty to 0. Timestamps set: `confirmedAt` (on confirmed), `completedAt` (on fully_received/closed), `cancelledAt` + `cancelReason` (on cancelled). Validates new supplier/warehouse if changing them. |
| POST | `/api/business/warehouse/purchase-orders/delete` | Deletes a PO. Only draft or cancelled POs can be deleted. Guards: checks for any GRNs referencing this PO (`where('poId','==',purchaseOrderId).limit(1)`). Returns 400 if GRNs exist. |

---

### Products (Shopify-linked)

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/products/create` | Creates a business product. Required: name, sku, weight, category, hsn, taxRate. Optional: description, price, stock (sets `inventory.openingStock`). SKU becomes the document ID. Guards: duplicate SKU → 400. Sets all inventory fields to 0 (inwardAddition, deduction, autoAddition, autoDeduction, blockedStock). Batch-writes product doc + audit log entry (lists all initial field values). Returns `{success, message, product, logId}`. |
| POST | `/api/business/products/update` | Updates a business product. Required: name, weight, category, hsn, taxRate. Optional: description, price, stock, status. Detects changes via `getChanges()` (field-level diff against existing doc). If no changes detected, returns 200 with `changes: []` without writing. Otherwise batch-writes update + audit log with old/new values per changed field. Returns formatted change list with `oldValueFormatted` / `newValueFormatted`. |
| POST | `/api/business/products/delete` | Deletes a business product and cleans up all its mappings. Removes product's `mappedVariants` from each store product (`FieldValue.delete()` on `variantMappings[variantId]`, `variantMappingDetails[variantId]`, and `FieldValue.arrayRemove(variantId)` from `variantMappingsArray`). Deletes all log docs in the product's `logs` subcollection. Creates a `deletedProductsLog` entry at the business level for audit. Returns `{sku, productName, mappingsRemoved}`. |
| POST | `/api/business/products/bulk-upload` | Bulk add or update business products via Excel or CSV upload. **Mode `add`:** Required columns: SKU, Product Name, Weight, HSN, Tax Rate. Skips existing SKUs. Creates product with full inventory initialization. **Mode `update`:** Required column: SKU only. Skips non-existing SKUs. Only updates fields explicitly present in the row (excluding stock changes — use inventory adjustment API for those). Both modes: validates Weight > 0, TaxRate ≥ 0, Price ≥ 0, Stock ≥ 0. Batch-writes (max 450 per batch). Returns result Excel with Status/Message column per row (Success/Error/Skipped) and base64-encoded data. |
| POST | `/api/business/products/bulk-remove-all-mappings` | Removes all Shopify variant mappings for selected or all business products. `removeAll=true` gets all products with non-empty `mappedVariants`. For each product: groups mappings by `storeId:productId`, batch-removes `variantMappings`, `variantMappingsArray`, `variantMappingDetails` from each store product. Clears `mappedVariants: []` on business product. Creates audit log per product. Returns `{summary: {processed, successful, mappingsRemoved, errors, skipped}}`. |
| POST | `/api/business/products/logs` | Fetches audit log for a specific product SKU. Ordered by `performedAt` desc. Max 100 entries. Converts `performedAt` Firestore timestamp to ISO string. Returns `{sku, productName, logs[], totalLogs}`. |
| POST | `/api/shopify/products/create-mapping` | Maps a single Shopify store variant to a business product. Validates: store linked to business, business product exists, store product exists, variant ID exists in product's variants array, variant not already mapped. Writes mapping to both sides in a batch (store product + business product + audit log). Returns mapping details. Guards: 409 if already mapped to any SKU. |
| POST | `/api/shopify/products/remove-mapping` | Removes a variant mapping. Guards: validates `variantMappingDetails[variantId].businessId === businessId` (only the business that created the mapping can remove it). Removes from store product and from business product's `mappedVariants` array (filters by storeId + productId + variantId). Creates audit log on business product. |
| POST | `/api/shopify/products/bulk-mapping` | Bulk-maps store variants to business products via Excel/CSV. Required columns: Store ID, Store Product Title, Store Product SKU, Business Product SKU. For each row: validates store is linked to business, finds variant by matching `Store Product SKU` against all variants in that store's products, validates business product exists, skips if already mapped to same SKU. Commits in batches of 450. Returns result Excel with Status/Message. |
| POST | `/api/shopify/products/store-variants` | Fetches all variants across all store products for the business. Supports filters: `storeFilter` (specific store ID), `mappingFilter` ('mapped'/'unmapped'), `searchQuery` (matches productTitle, variantTitle, variantSku, or vendor). On shared stores for non-super-admin: filters products by `vendor == businessData.vendorName`. Returns `{variants: [{variantId, variantTitle, variantSku, productId, productTitle, vendor, storeId, mappedBusinessSku, price, inventoryQuantity}], stores: [{id, shopName}], total}`. |
| POST | `/api/shopify/products/export-store-variants` | Same filtering logic as store-variants but returns an Excel file. Columns: Store Product Title, Variant Title, Variant SKU, Store, Is Mapped (TRUE/FALSE), Mapped to Business SKU. Header styled indigo, alternate row gray, TRUE/FALSE color-coded green/red. Auto-filter and frozen header row. |
| POST | `/api/shopify/products/search-business-products` | Searches business products by name or SKU. Minimum 2 characters. Case-insensitive contains search. Returns up to 20 results. Sorted by relevance: exact SKU match first, then SKU starts-with, then alphabetical. |
| POST | `/api/shopify/products/sync` | Full Shopify product sync. Paginates through Shopify products API (250 per page, follows Link headers). Gets all existing non-deleted Firestore product IDs (listDocuments — no data reads). For existing orders: `batch.set(ref, data, {merge: true})` preserving customStatus and isDeleted. For new orders: `batch.create(ref, {...data, isDeleted: false, customStatus: 'New'})`. Commits in chunks of 500. Creates a `logs` entry with sync stats. Returns `{stats: {total, created, updated, deleted, errors}}`. |

---

### Reports

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/generate-tax-report` | Queues a GST tax report job. Required: businessId, storeIds (string[]), startDate, endDate (YYYY-MM-DD). Validates: storeIds are all in the business's `stores` array. Calls `GENERATE_CUSTOM_TAX_REPORT_URL` Cloud Function with 10-second timeout. Returns 202 with `{taskName, docId, dateRange}`. Job status is tracked in `users/{businessId}/tax_reports/{docId}` (real-time on Tax Reports page). |
| POST | `/api/business/generate-gross-profit-report` | Generates gross profit report data. Required: businessId, startDate, endDate (yyyy-mm-dd). Sets `users/{businessId}.grossProfitData.loading = true` in Firestore. Fire-and-forget call to `grossProfitReport` Cloud Function (does not wait for completion). Frontend polls via onSnapshot. Returns 202. |
| POST | `/api/business/generate-remittance-table` | Generates remittance table data. Required: businessId, startDate, endDate, courier (must be 'Blue Dart' or 'Delhivery'). Courier mapped to Firestore key: 'Blue Dart' → `blueDart`, 'Delhivery' → `delhivery`. Sets `users/{businessId}.remittanceTable.{fsKey}.loading = true`. Fire-and-forget to `generateRemittanceTable` Cloud Function (uses `ENQUEUE_FUNCTION_SECRET` header). Returns 202. |

---

### Members

| Method | Route | Description |
|---|---|---|
| POST | `/api/business/members/create-invite` | Creates a one-time invite session for adding a member to a business. Valid roles: `Admin` or `Member`. Session stored at `join-a-business/{sessionId}` with: businessId, businessName, role, permissions, expiresAt (1 hour), createdBy, used=false. Returns sessionId (client builds invite URL: `/business/join/{sessionId}`). |
| POST | `/api/business/members/accept-request` | Super admin only (guards: businessId must equal `SUPER_ADMIN_ID`). Accepts a vendor join request in a Firestore transaction. Checks: request status must be 'pending', user not already member of both shared stores (`SHARED_STORE_ID` + `SHARED_STORE_ID_2`). Grants access: adds user to `accounts/{SHARED_STORE_ID}/members/{userId}` and `accounts/{SHARED_STORE_ID_2}/members/{userId}` with role='Vendor', vendorName, and permissions. Updates `users/{requestUserId}.stores` to include both shared stores and sets `vendorName`. Sets request status='accepted'. Then recomputes and updates Firebase custom claims for the new member. |
| POST | `/api/business/members/decline-request` | Super admin only. Sets request status='declined' and records processedAt + processedBy. |
| POST | `/api/business/members/join` | Joins a business using a sessionId (from invite link). Validates: session exists, not used, not expired. Firestore transaction: adds user to `users/{businessId}/members/{userId}` with role/permissions, updates `users/{userId}.businesses` array to include businessId, marks session `used=true`. After transaction: recomputes custom claims to include the new business's stores in `accessibleStores`. |
| POST | `/api/business/members/request-join` | Requests to become a vendor on the Majime platform (join the shared stores). Required: vendorName. Validates: user not already vendor of both shared stores; vendorName not already taken (case-insensitive, checks existing members of both shared stores + pending requests); no existing pending request from this user. Creates a join-request doc on `users/{SUPER_ADMIN_ID}/join-requests/{requestId}`. |

---

### Integrations

| Method | Route | Description |
|---|---|---|
| POST | `/api/integrations/courier/update` | Stores API credentials for a generic courier integration. Required: businessId, courierName, apiKey. Writes to `users/{businessId}.integrations.couriers.{courierName}.apiKey`. |
| POST | `/api/integrations/courier/delete` | Removes a courier integration completely. Deletes the `integrations.couriers.{courierName}` key AND removes the courier from `integrations.couriers.priorityList` array. |
| POST | `/api/integrations/courier/update-priority` | Sets the priority courier system. Writes `integrations.couriers.priorityEnabled` (bool) and `integrations.couriers.priorityList` (array of courier objects). When `Priority` is selected as courier during AWB assignment, the system iterates through this list in order. |
| POST | `/api/integrations/shiprocket/update` | Configures Shiprocket. Validates credentials by actually calling the Shiprocket auth API (`/v1/external/auth/login`) to get a token first — fails with 'Incorrect email or password' if creds invalid. Stores email, password, and apiKey (JWT token) under `integrations.couriers.shiprocket`. Also appends `{name: "shiprocket", mode: "Surface"}` to `priorityList` via `FieldValue.arrayUnion`. |
| POST | `/api/integrations/xpressbees/update` | Same pattern as Shiprocket. Validates by calling Xpressbees auth API, stores credentials + token. Appends `{name: 'xpressbees', mode: 'Surface'}` to priorityList. |
| POST | `/api/integrations/bluedart/update` | Stores Blue Dart credentials: customerCode, loginId, trackingLicenceKey, licenceKey, and optionally appApiKey, appApiSecret. Does not validate credentials at save time. |
| POST | `/api/integrations/shiprocket/refresh-token` | **Deprecated.** Reads credentials from `accounts/{shop}` (old data structure). Refreshes token and writes back to that doc. Not used with new `users/{businessId}` structure. |
| POST | `/api/integrations/xpressbees/refresh-token` | **Deprecated.** Same issue as Shiprocket refresh. Reads from `accounts/{shop}`. |
| POST | `/api/integrations/interakt/*` | **All deprecated.** Returns 410 Gone with `{error: 'This functionality has been removed.'}`. WhatsApp/Interakt integration was fully removed. |

---

### Shopify Auth & Setup

| Method | Route | Description |
|---|---|---|
| POST | `/api/shopify/auth` | Initiates the Shopify OAuth flow. Generates a 16-byte random hex CSRF `state` token, stores in an httpOnly cookie (`shopify_oauth_state`, 5-minute TTL). Constructs the Shopify auth URL with full scope list (read/write orders, products, fulfillments, inventory, etc.) and redirectUri pointing to `/api/shopify/callback`. |
| GET | `/api/shopify/callback` | Shopify OAuth callback. Validates CSRF state cookie. Validates HMAC signature (SHA-256 over all params except hmac). Exchanges auth code for access token. Stores token at `accounts/{shop}.accessToken`. Registers/updates webhooks for: `orders/create`, `orders/updated`, `orders/delete`, `products/create`, `products/update`, `products/delete` — updates URL if already exists, creates if not. Redirects to `/dashboard`. |
| POST | `/api/shopify/backfill` | Full historical order backfill from Shopify (all statuses, paginated 50/page). Preloads existing Firestore order IDs (listDocuments — no data reads). For existing orders: `batch.set(ref, data, {merge: true})` preserving customStatus and isDeleted. For new orders: `batch.create(ref, {...data, isDeleted: false, customStatus: 'New'})`. Commits in chunks of 500. |
| POST | `/api/shopify/locations/add` | Adds a pickup location to `users/{businessId}/pickupLocations`. Required: name, address, city, postcode, country. |
| POST | `/api/shopify/locations/update` | Updates an existing pickup location. Same field requirements. |
| POST | `/api/shopify/locations/delete` | Deletes a pickup location. Idempotent (returns success even if not found). |

---

### Settings

| Method | Route | Description |
|---|---|---|
| POST | `/api/shopify/account/toggle-service` | Toggles a customer-facing service on/off. Valid services: `['bookReturnPage']`. Writes `users/{businessId}.customerServices.{serviceName}.enabled = isEnabled`. |
| POST | `/api/shopify/account/update-address` | Updates the business's company address (`companyAddress` field on `users/{businessId}`). |
| POST | `/api/shopify/account/update-contact` | Updates the business's primary contact (`primaryContact` field on `users/{businessId}`). |

---

### Webhooks (Internal — not for agent use)

| Method | Route | Description |
|---|---|---|
| POST | `/api/webhooks/orders` | Shopify order webhook handler. Handles: `orders/create` (sets customStatus='New'), `orders/updated` (merges changes), `orders/delete` (marks isDeleted=true). HMAC-verified. |
| POST | `/api/webhooks/waba` | WhatsApp Business API webhook handler. **Deprecated.** |

---

### Public (No auth — not for agent use)

These routes are customer-facing and do not require business authentication:
- `/api/public/book-return/*` — customer return booking flow (multi-step, with image upload, CSRF protection, rate limiting)
- `/api/public/confirm-or-cancel/*` — customer order confirmation/cancellation via WhatsApp button link
- `/api/public/track/*` — public shipment tracking
- `/api/public/join-business/*` — join business via invite session