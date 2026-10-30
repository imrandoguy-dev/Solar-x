# Solar X

Rooftop solar EPC workflow (Lead → Site Visit → Quotation → Loan → Paper Work → KSEB & Subsidy → Installation → Commissioning → AMC) running as a **full-screen app inside ERPNext** at `/app/solar-x`.

This is a standalone test app. It does not depend on or touch `hiper_solar`. Its purpose is to try the new workflow/UI against **real ERPNext documents** and surface the integration problems before the real build.

## What it creates in ERPNext

| Solar X step | ERPNext documents |
|---|---|
| New Lead | `Lead` + `Solar Project` (duplicate check on mobile) |
| Schedule site visit | `ToDo` assigned to the surveyor |
| Save quotation | `Customer` (first time) + draft `Quotation` |
| Customer accepted | `Quotation` submitted, `Sales Order` created + submitted, advance `Sales Invoice` (draft) |
| Record payment | `Sales Invoice` submitted + `Payment Entry` created + submitted |
| Complete installation | installation-milestone `Sales Invoice` (draft) |
| Complete commissioning | final `Sales Invoice` (draft), next service date |
| WhatsApp messages | simulated: logged as comments on the Solar Project (plus a wa.me link for quotes) |

## Install (Frappe Press)

1. Press → Apps → add `https://github.com/imrandoguy-dev/Solar-x` (branch `main`).
2. Deploy to the bench group, install **Solar X** on the test site (ERPNext must already be installed).
3. Open **Solar X Settings** (`/app/solar-x-settings`) and fill in Company, Solar System Item, Customer Group, Territory, Mode of Payment.
4. Give users the roles: `Solar Manager`, `Solar Sales`, `Solar Surveyor`, `Solar Installer`, `Solar Accounts`.
5. Open `/app/solar-x` → **Setup Check** and fix every ❌.

## Moving back

* Every forward action shows an **Undo** toast for 10 seconds.
* **← Move back** on a project (and **←** on the KSEB / Subsidy boards) always asks for a reason and is logged in Stage History.
* Staff can only undo their own move on the same day; after that only `Solar Manager` can move a project back.
* A move back is **blocked** when a submitted ERPNext document depends on the stage (Sales Order, a submitted milestone invoice). Cancel it in ERPNext first. Draft invoices are deleted automatically.

## Errors you are likely to hit (and why)

These are the integration points this test is meant to expose. The **Setup Check** screen tests most of them up front.

1. **Solar item is a stock item.** Sales Order/Invoice then need a warehouse and stock → *"Delivery warehouse required"*. Use a non-stock item.
2. **UOM "Nos" is whole-number only.** A 5.5 kW quotation fails with *"Quantity cannot be a fraction"*. Use a UOM like `kW`.
3. **No Customer Group / Territory default.** Customer creation fails on first quotation.
4. **Mode of Payment has no account for the company.** Payment Entry fails: *"Please set default Cash or Bank account in Mode of Payment"*.
5. **No Fiscal Year for today / no default receivable account.** Invoice or payment submit fails.
6. **Taxes template from another company** (multi-company sites) → invoice validation error.
7. **Milestone invoices are not linked to Sales Order lines.** The Sales Order stays "To Bill" forever. In the real build, bill through the Sales Order (`make_sales_invoice`) with proportional qty or use Payment Terms.
8. **Cancelling in ERPNext after acceptance.** Moving a project back past Quotation needs the Sales Order (and any submitted invoice + payment) cancelled first. Solar X blocks the move and says which document.
9. **Role / permission gaps.** Users without the right Solar role see the stage but the server refuses the action (*"Only Solar Installer … can act"*). Surveyors/installers only see projects assigned to them.
10. **Duplicate mobile numbers.** The same customer cannot have two open Solar Projects; existing ERPNext Leads with the same mobile are not merged automatically.
11. **ERPNext Lead fields differ by version** (e.g. `source` must be an existing Lead Source). The app creates the standard sources on migrate.
12. **Concurrent edits.** Two users acting on the same project at once → *"Document has been modified after you have opened it"*. Refresh and retry.

## Structure

```
solar_x/
  api.py                 all server actions (whitelisted)
  permissions.py         surveyor/installer row-level access
  setup.py               roles + lead sources
  solar_x/doctype/       Solar Project (+3 child tables), Solar X Settings
  solar_x/page/solar_x/  the full-screen app (/app/solar-x)
```
