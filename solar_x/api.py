"""Solar X server API.

Every action the Solar X page performs goes through a whitelisted method here.
Each one checks the user's Solar role, moves the Solar Project, and creates the
real ERPNext documents (Lead, Customer, Quotation, Sales Order, Sales Invoice,
Payment Entry) so integration problems surface exactly as they would in production.
"""

import frappe
from frappe import _
from frappe.utils import add_days, add_months, cint, date_diff, flt, getdate, now_datetime, nowdate

STAGES = ["Lead", "Site Visit", "Quotation", "Loan", "Paper Work", "Approvals", "Installation", "Commissioning", "AMC"]
KSEB = ["Not Started", "Application Submitted", "Feasibility Approved", "Inspection", "Meter Installation", "Synchronised"]
SUBSIDY = ["Not Started", "Registered", "Applied", "Inspection", "Redeemed"]
DOC_TYPES = ["Aadhaar", "Latest KSEB bill", "Ownership proof", "Bank passbook", "Customer photo"]
CHECKS = ["Structure mounted", "Panels fixed", "Inverter wired", "Earthing & lightning arrester", "Photos uploaded"]
STAGE_ROLE = {
	"Lead": "Solar Sales",
	"Site Visit": "Solar Surveyor",
	"Quotation": "Solar Sales",
	"Loan": "Solar Accounts",
	"Paper Work": "Solar Sales",
	"Approvals": "Solar Sales",
	"Installation": "Solar Installer",
	"Commissioning": "Solar Installer",
	"AMC": "Solar Installer",
}
MANAGER_ROLES = {"Solar Manager", "System Manager"}
SOLAR_ROLES = ["Solar Manager", "Solar Sales", "Solar Surveyor", "Solar Installer", "Solar Accounts"]
INVOICE_FIELDS = {"advance": "advance_invoice", "installation": "installation_invoice", "final": "final_invoice"}
INVOICE_LABEL = {"advance": "Advance", "installation": "Installation milestone", "final": "Final (commissioning)"}

PROJECT_FIELDS = [
	"name", "customer_name", "mobile_no", "email_id", "place", "stage", "stage_since", "company", "source",
	"monthly_bill", "lead_status", "follow_up_date", "lead", "customer", "lost_reason", "sales_person",
	"surveyor", "installer", "visit_date", "address", "roof_type", "shadow_free_area", "phase",
	"connected_load", "kseb_consumer_no", "kseb_section", "system_kw", "panel_brand", "inverter_brand",
	"price_per_kw", "project_value", "subsidy_amount", "quotation", "sales_order", "loan_required",
	"loan_bank", "loan_amount", "loan_status", "kseb_stage", "kseb_stage_since", "subsidy_stage",
	"subsidy_stage_since", "commission_date", "first_generation", "next_service_date", "advance_invoice",
	"installation_invoice", "final_invoice", "modified", "creation",
]


# ---------------------------------------------------------------- helpers
def _settings():
	return frappe.get_cached_doc("Solar X Settings")


def _roles():
	return set(frappe.get_roles())


def _is_manager():
	return bool(_roles() & MANAGER_ROLES)


def _require(stage):
	role = STAGE_ROLE.get(stage)
	if not (_is_manager() or role in _roles()):
		frappe.throw(
			_("Only {0} (or Solar Manager) can act on the {1} stage.").format(role, stage),
			frappe.PermissionError,
		)


def _require_role(role):
	if not (_is_manager() or role in _roles()):
		frappe.throw(_("You need the {0} role for this.").format(role), frappe.PermissionError)


def _get(name, stage=None):
	doc = frappe.get_doc("Solar Project", name)
	doc.check_permission("write")
	if stage and doc.stage != stage:
		frappe.throw(
			_("{0} is at stage {1}, not {2}. Refresh the page.").format(name, doc.stage, stage),
			title=_("Stage changed"),
		)
	if stage:
		_require(stage)
	return doc


def _log(doc, frm, to, direction="Forward", reason=None):
	doc.append(
		"stage_log",
		{"from_stage": frm, "to_stage": to, "direction": direction, "reason": reason,
		 "user": frappe.session.user, "on": now_datetime()},
	)


def _set_stage(doc, to, direction="Forward", reason=None):
	_log(doc, doc.stage, to, direction, reason)
	doc.stage = to
	doc.stage_since = now_datetime()
	if to == "Paper Work" and not doc.documents:
		for d in DOC_TYPES:
			doc.append("documents", {"document_type": d})
	if to == "Installation" and not doc.install_checks:
		for c in CHECKS:
			doc.append("install_checks", {"check_item": c})


def _notify(doc, text):
	"""Simulated WhatsApp message: recorded on the project timeline."""
	doc.add_comment("Info", _("WhatsApp to {0} ({1}): {2}").format(doc.customer_name, doc.mobile_no, text))


def _invoice_paid(si_name):
	if not si_name:
		return False
	row = frappe.db.get_value("Sales Invoice", si_name, ["docstatus", "outstanding_amount"], as_dict=True)
	return bool(row and row.docstatus == 1 and flt(row.outstanding_amount) <= 0.01)


def _sla(s, stage):
	key = "sla_" + stage.lower().replace(" ", "_")
	return cint(s.get(key)) or 0


def _kseb_sla(s, st):
	return cint(
		{
			"Application Submitted": s.sla_kseb_application,
			"Feasibility Approved": s.sla_kseb_feasibility,
			"Inspection": s.sla_kseb_inspection,
			"Meter Installation": s.sla_kseb_meter,
		}.get(st)
		or 0
	)


def _sub_sla(s, st):
	return cint({"Registered": s.sla_sub_registered, "Applied": s.sla_sub_applied,
				 "Inspection": s.sla_sub_inspection}.get(st) or 0)


def _days(dt):
	return date_diff(nowdate(), getdate(dt)) if dt else 0


def _taxes(s, company):
	if not s.taxes_template:
		return []
	from erpnext.controllers.accounts_controller import get_taxes_and_charges

	return get_taxes_and_charges("Sales Taxes and Charges Template", s.taxes_template) or []


# ---------------------------------------------------------------- read
@frappe.whitelist()
def bootstrap():
	s = _settings()
	projects = frappe.get_list("Solar Project", fields=PROJECT_FIELDS, order_by="modified desc", limit_page_length=1000)

	inv_names = [p[f] for p in projects for f in INVOICE_FIELDS.values() if p.get(f)]
	invoices = {}
	if inv_names:
		for r in frappe.get_all(
			"Sales Invoice",
			filters={"name": ["in", inv_names]},
			fields=["name", "docstatus", "grand_total", "outstanding_amount", "due_date"],
		):
			invoices[r.name] = r

	for p in projects:
		p.days_in_stage = _days(p.stage_since)
		sla = _sla(s, p.stage) if p.stage in STAGES else 0
		p.sla = sla
		p.overdue = bool(sla and p.days_in_stage > sla and p.stage not in ("AMC", "Lost"))
		p.kseb_days = _days(p.kseb_stage_since)
		p.kseb_sla = _kseb_sla(s, p.kseb_stage)
		p.kseb_overdue = bool(p.kseb_sla and p.kseb_days > p.kseb_sla)
		p.sub_days = _days(p.subsidy_stage_since)
		p.sub_sla = _sub_sla(s, p.subsidy_stage)
		p.sub_overdue = bool(p.sub_sla and p.sub_days > p.sub_sla)
		billed = received = 0
		p.milestones = {}
		for key, field in INVOICE_FIELDS.items():
			inv = invoices.get(p.get(field))
			if inv:
				total = flt(inv.grand_total)
				paid = total - flt(inv.outstanding_amount) if inv.docstatus == 1 else 0
				billed += total if inv.docstatus == 1 else 0
				received += paid
				p.milestones[key] = {
					"invoice": inv.name, "docstatus": inv.docstatus, "total": total,
					"outstanding": flt(inv.outstanding_amount) if inv.docstatus == 1 else total,
					"paid": inv.docstatus == 1 and flt(inv.outstanding_amount) <= 0.01,
				}
		p.received = received
		p.billed = billed

	team = {}
	for role in SOLAR_ROLES:
		users = frappe.get_all(
			"Has Role", filters={"role": role, "parenttype": "User"}, pluck="parent", distinct=True
		)
		team[role] = [
			{"user": u.name, "full_name": u.full_name}
			for u in frappe.get_all("User", filters={"name": ["in", users or [""]], "enabled": 1},
									fields=["name", "full_name"])
		]

	me = frappe.session.user
	return {
		"projects": projects,
		"team": team,
		"roles": sorted(_roles() & (set(SOLAR_ROLES) | MANAGER_ROLES)),
		"is_manager": _is_manager(),
		"user": me,
		"full_name": frappe.utils.get_fullname(me),
		"settings": {
			"company": s.company,
			"default_price_per_kw": flt(s.default_price_per_kw),
			"advance_percent": flt(s.advance_percent),
			"installation_percent": flt(s.installation_percent),
			"final_percent": flt(s.final_percent),
			"currency": frappe.db.get_value("Company", s.company, "default_currency") if s.company else "INR",
		},
		"setup_problems": len([c for c in setup_check() if not c["ok"]]),
	}


@frappe.whitelist()
def get_project(name):
	doc = frappe.get_doc("Solar Project", name)
	doc.check_permission("read")
	out = doc.as_dict()
	out["files"] = frappe.get_all(
		"File",
		filters={"attached_to_doctype": "Solar Project", "attached_to_name": name},
		fields=["name", "file_name", "file_url", "creation"],
		order_by="creation desc",
	)
	out["comments"] = frappe.get_all(
		"Comment",
		filters={"reference_doctype": "Solar Project", "reference_name": name,
				 "comment_type": ["in", ["Info", "Comment"]]},
		fields=["content", "owner", "creation", "comment_type"],
		order_by="creation desc",
		limit_page_length=40,
	)
	out["invoices"] = {}
	for key, field in INVOICE_FIELDS.items():
		if doc.get(field):
			out["invoices"][key] = frappe.db.get_value(
				"Sales Invoice", doc.get(field),
				["name", "docstatus", "grand_total", "outstanding_amount", "due_date"], as_dict=True,
			)
	return out


# ---------------------------------------------------------------- lead
@frappe.whitelist()
def create_lead(customer_name, mobile_no, place=None, monthly_bill=0, source=None, sales_person=None,
				email_id=None, system_kw=None):
	_require("Lead")
	s = _settings()
	if not s.company:
		frappe.throw(_("Set the Company in Solar X Settings first."), title=_("Setup incomplete"))
	mobile = "".join(ch for ch in (mobile_no or "") if ch.isdigit() or ch == "+")
	if not customer_name or not mobile:
		frappe.throw(_("Customer name and mobile number are required."))

	dup = frappe.db.get_value("Solar Project", {"mobile_no": mobile, "stage": ["!=", "Lost"]}, "name")
	if dup:
		return {"duplicate": dup}

	lead = frappe.get_doc({
		"doctype": "Lead",
		"first_name": customer_name,
		"mobile_no": mobile,
		"email_id": email_id,
		"city": place,
		"company": s.company,
		"source": source if source and frappe.db.exists("Lead Source", source) else None,
	})
	lead.insert()

	doc = frappe.get_doc({
		"doctype": "Solar Project",
		"customer_name": customer_name, "mobile_no": mobile, "email_id": email_id, "place": place,
		"monthly_bill": flt(monthly_bill), "source": source, "company": s.company,
		"sales_person": sales_person or frappe.session.user, "lead": lead.name, "stage": "Lead",
		"lead_status": "New", "follow_up_date": add_days(nowdate(), 1), "stage_since": now_datetime(),
		"system_kw": flt(system_kw) or None,
	})
	_log(doc, "", "Lead", "Forward", "Lead created")
	doc.insert()
	return {"name": doc.name}


@frappe.whitelist()
def mark_contacted(name):
	doc = _get(name, "Lead")
	doc.lead_status = "Contacted"
	doc.follow_up_date = add_days(nowdate(), 2)
	doc.save()
	return {"name": name}


@frappe.whitelist()
def mark_lost(name, reason):
	doc = _get(name)
	_require(doc.stage)
	if doc.stage not in ("Lead", "Site Visit", "Quotation"):
		frappe.throw(_("Only projects before quote acceptance can be marked lost."))
	if not reason:
		frappe.throw(_("Give a reason."))
	if doc.quotation and frappe.db.get_value("Quotation", doc.quotation, "docstatus") == 1:
		frappe.throw(_("Quotation {0} is submitted. Set it to Lost in ERPNext first.").format(doc.quotation))
	doc.lost_reason = reason
	_set_stage(doc, "Lost", "Forward", reason)
	doc.save()
	return {"name": name}


@frappe.whitelist()
def schedule_visit(name, visit_date, surveyor):
	doc = _get(name, "Lead")
	if not surveyor:
		frappe.throw(_("Pick a surveyor."))
	doc.visit_date = visit_date
	doc.surveyor = surveyor
	_set_stage(doc, "Site Visit")
	doc.save()
	from frappe.desk.form.assign_to import add as assign

	assign({
		"assign_to": [surveyor], "doctype": "Solar Project", "name": name,
		"description": _("Site visit for {0} on {1}").format(doc.customer_name, visit_date),
		"date": visit_date,
	})
	_notify(doc, _("Site visit confirmed for {0}.").format(frappe.utils.formatdate(visit_date)))
	return {"name": name}


# ---------------------------------------------------------------- survey
@frappe.whitelist()
def complete_survey(name, roof_type=None, shadow_free_area=None, phase=None, connected_load=None,
					kseb_consumer_no=None, kseb_section=None, address=None):
	doc = _get(name, "Site Visit")
	doc.update({
		"roof_type": roof_type, "shadow_free_area": flt(shadow_free_area), "phase": phase,
		"connected_load": connected_load, "kseb_consumer_no": kseb_consumer_no,
		"kseb_section": kseb_section, "address": address or doc.address,
	})
	missing = [lbl for f, lbl in [("roof_type", "Roof type"), ("shadow_free_area", "Shadow-free area"),
								  ("phase", "Phase"), ("kseb_consumer_no", "KSEB consumer number")]
			   if not doc.get(f)]
	if missing:
		frappe.throw(_("Fill in: {0}").format(", ".join(missing)), title=_("Survey incomplete"))
	photos = frappe.db.count("File", {"attached_to_doctype": "Solar Project", "attached_to_name": name})
	if photos < 2:
		frappe.throw(_("Upload at least 2 site photos (found {0}).").format(photos), title=_("Survey incomplete"))
	if not doc.system_kw:
		by_area = flt(doc.shadow_free_area) / 100
		by_bill = flt(doc.monthly_bill) / 900 if doc.monthly_bill else by_area
		doc.system_kw = max(1, min(20, round(min(by_area, by_bill))))
	_set_stage(doc, "Quotation")
	doc.save()
	return {"name": name}


# ---------------------------------------------------------------- quotation
def _ensure_customer(doc, s):
	if doc.customer and frappe.db.exists("Customer", doc.customer):
		return doc.customer
	group = s.customer_group or frappe.db.get_single_value("Selling Settings", "customer_group")
	territory = s.territory or frappe.db.get_single_value("Selling Settings", "territory")
	if not group or not territory:
		frappe.throw(
			_("Set Customer Group and Territory in Solar X Settings (or Selling Settings)."),
			title=_("Setup incomplete"),
		)
	cust = frappe.get_doc({
		"doctype": "Customer", "customer_name": doc.customer_name, "customer_type": "Individual",
		"customer_group": group, "territory": territory, "lead_name": doc.lead,
		"mobile_no": doc.mobile_no, "email_id": doc.email_id,
	})
	cust.insert()
	doc.customer = cust.name
	return cust.name


def _check_item(s):
	if not s.solar_item:
		frappe.throw(_("Set the Solar System Item in Solar X Settings."), title=_("Setup incomplete"))
	if not frappe.db.exists("Item", s.solar_item):
		frappe.throw(_("Item {0} (Solar X Settings) does not exist.").format(s.solar_item))


@frappe.whitelist()
def save_quotation(name, system_kw, price_per_kw, panel_brand=None, inverter_brand=None):
	doc = _get(name, "Quotation")
	s = _settings()
	_check_item(s)
	if flt(system_kw) <= 0 or flt(price_per_kw) <= 0:
		frappe.throw(_("System size and price per kW must be more than zero."))
	doc.update({"system_kw": flt(system_kw), "price_per_kw": flt(price_per_kw),
				"panel_brand": panel_brand, "inverter_brand": inverter_brand})
	customer = _ensure_customer(doc, s)

	if doc.quotation and frappe.db.get_value("Quotation", doc.quotation, "docstatus") in (0, 1):
		q = frappe.get_doc("Quotation", doc.quotation)
		if q.docstatus != 0:
			frappe.throw(_("Quotation {0} is already submitted.").format(q.name))
		q.items = []
		q.taxes = []
	else:
		q = frappe.new_doc("Quotation")
	q.update({
		"quotation_to": "Customer", "party_name": customer, "company": doc.company,
		"transaction_date": nowdate(), "valid_till": add_days(nowdate(), 15), "order_type": "Sales",
	})
	q.append("items", {
		"item_code": s.solar_item, "qty": flt(system_kw), "rate": flt(price_per_kw),
		"description": _("{0} kW on-grid rooftop solar system - {1} panels, {2} inverter").format(
			system_kw, panel_brand or "-", inverter_brand or "-"),
	})
	if s.taxes_template:
		q.taxes_and_charges = s.taxes_template
		for t in _taxes(s, doc.company):
			q.append("taxes", t)
	q.save()
	doc.quotation = q.name
	doc.add_comment("Info", _("Quotation {0} saved ({1} kW @ {2}/kW).").format(q.name, system_kw, price_per_kw))
	doc.save()
	return {"name": name, "quotation": q.name}


@frappe.whitelist()
def send_quotation(name):
	doc = _get(name, "Quotation")
	if not doc.quotation:
		frappe.throw(_("Save the quotation first."))
	_notify(doc, _("Your solar quotation {0} is ready.").format(doc.quotation))
	return {"name": name, "mobile_no": doc.mobile_no, "quotation": doc.quotation}


@frappe.whitelist()
def accept_quotation(name, loan_required=0):
	doc = _get(name, "Quotation")
	s = _settings()
	if not doc.quotation:
		frappe.throw(_("Save the quotation first."))
	q = frappe.get_doc("Quotation", doc.quotation)
	if q.docstatus == 0:
		q.submit()

	if not doc.sales_order:
		from erpnext.selling.doctype.quotation.quotation import make_sales_order

		so = make_sales_order(q.name)
		so.delivery_date = add_days(nowdate(), 30)
		for it in so.items:
			it.delivery_date = so.delivery_date
		so.insert()
		so.submit()
		doc.sales_order = so.name

	_make_invoice(doc, s, "advance")
	doc.loan_required = cint(loan_required)
	if doc.loan_required:
		doc.loan_status = "Applied"
		_set_stage(doc, "Loan")
	else:
		_set_stage(doc, "Paper Work")
	doc.save()
	_notify(doc, _("Thank you! Quote accepted. Advance of {0}% requested.").format(flt(s.advance_percent)))
	return {"name": name}


# ---------------------------------------------------------------- billing
def _make_invoice(doc, s, key):
	field = INVOICE_FIELDS[key]
	if doc.get(field) and frappe.db.exists("Sales Invoice", doc.get(field)):
		return doc.get(field)
	_check_item(s)
	pct = flt(s.get(key + "_percent"))
	if pct <= 0:
		return None
	si = frappe.new_doc("Sales Invoice")
	si.update({"customer": doc.customer, "company": doc.company, "posting_date": nowdate(),
			   "due_date": add_days(nowdate(), 7), "set_posting_time": 1})
	si.append("items", {
		"item_code": s.solar_item, "qty": 1, "rate": flt(doc.project_value) * pct / 100,
		"description": _("{0} ({1}%) - {2}, {3} kW rooftop solar").format(
			INVOICE_LABEL[key], pct, doc.name, doc.system_kw),
	})
	if s.taxes_template:
		si.taxes_and_charges = s.taxes_template
		for t in _taxes(s, doc.company):
			si.append("taxes", t)
	si.insert()
	doc.set(field, si.name)
	return si.name


@frappe.whitelist()
def record_payment(name, milestone, mode_of_payment=None, reference_no=None):
	_require_role("Solar Accounts")
	doc = frappe.get_doc("Solar Project", name)
	doc.check_permission("write")
	s = _settings()
	field = INVOICE_FIELDS.get(milestone)
	if not field or not doc.get(field):
		frappe.throw(_("No {0} invoice on {1} yet.").format(milestone, name))
	si = frappe.get_doc("Sales Invoice", doc.get(field))
	if si.docstatus == 2:
		frappe.throw(_("Invoice {0} is cancelled.").format(si.name))
	if si.docstatus == 0:
		si.submit()
	if flt(si.outstanding_amount) <= 0.01:
		frappe.throw(_("Invoice {0} is already fully paid.").format(si.name))

	from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

	pe = get_payment_entry("Sales Invoice", si.name)
	mop = mode_of_payment or s.mode_of_payment
	if not mop:
		frappe.throw(_("Set a Default Mode of Payment in Solar X Settings."), title=_("Setup incomplete"))
	pe.mode_of_payment = mop
	pe.reference_no = reference_no or doc.name
	pe.reference_date = nowdate()
	pe.insert()
	pe.submit()
	doc.add_comment("Info", _("Payment {0} recorded against {1}.").format(pe.name, si.name))
	_notify(doc, _("Payment of {0} received. Thank you!").format(
		frappe.utils.fmt_money(pe.paid_amount, currency=pe.paid_from_account_currency)))
	return {"name": name, "payment_entry": pe.name}


# ---------------------------------------------------------------- loan / paperwork
@frappe.whitelist()
def save_loan(name, loan_bank=None, loan_amount=0, loan_status="Applied"):
	doc = _get(name, "Loan")
	doc.update({"loan_bank": loan_bank, "loan_amount": flt(loan_amount), "loan_status": loan_status})
	if loan_status == "Disbursed":
		if not loan_bank:
			frappe.throw(_("Enter the bank before marking the loan disbursed."))
		_set_stage(doc, "Paper Work")
	doc.save()
	return {"name": name}


@frappe.whitelist()
def set_document(name, document_type, received=0, attachment=None):
	doc = _get(name, "Paper Work")
	row = next((d for d in doc.documents if d.document_type == document_type), None)
	if not row:
		frappe.throw(_("Unknown document {0}.").format(document_type))
	row.received = cint(received)
	if attachment:
		row.attachment = attachment
	doc.save()
	return {"name": name}


@frappe.whitelist()
def complete_paperwork(name):
	doc = _get(name, "Paper Work")
	pending = [d.document_type for d in doc.documents if not d.received]
	if pending:
		frappe.throw(_("Still missing: {0}").format(", ".join(pending)), title=_("Paper work incomplete"))
	_set_stage(doc, "Approvals")
	doc.kseb_stage, doc.kseb_stage_since = "Application Submitted", now_datetime()
	doc.subsidy_stage, doc.subsidy_stage_since = "Registered", now_datetime()
	doc.save()
	_notify(doc, _("Your KSEB net-meter and PM Surya Ghar applications have been submitted."))
	return {"name": name}


# ---------------------------------------------------------------- KSEB / subsidy boards
def _move_track(name, track, direction, reason):
	doc = frappe.get_doc("Solar Project", name)
	doc.check_permission("write")
	_require("Approvals")
	steps, field, since = (KSEB, "kseb_stage", "kseb_stage_since") if track == "kseb" else \
		(SUBSIDY, "subsidy_stage", "subsidy_stage_since")
	label = "KSEB" if track == "kseb" else "Subsidy"
	if doc.stage in ("Lead", "Site Visit", "Quotation", "Loan", "Paper Work", "Lost"):
		frappe.throw(_("{0} tracking starts after paper work is complete.").format(label))
	idx = steps.index(doc.get(field) or steps[0])
	new = idx + (1 if direction == "forward" else -1)
	if new < 1 or new >= len(steps):
		frappe.throw(_("{0} cannot move further {1}.").format(label, "forward" if direction == "forward" else "back"))
	if direction == "back":
		if not reason:
			frappe.throw(_("Give a reason for moving back."))
		if track == "kseb":
			if idx == 5 and doc.stage == "AMC":
				frappe.throw(_("Project is already commissioned. Move the project back to Commissioning first."))
			if new < 2 and doc.stage in ("Installation", "Commissioning", "AMC"):
				frappe.throw(
					_("Installation already started on the basis of feasibility approval. Move the project "
					  "back to KSEB & Subsidy first."))
	if track == "kseb" and steps[new] == "Synchronised" and doc.stage not in ("Commissioning", "AMC", "Installation"):
		frappe.throw(_("Meter synchronisation comes after installation has started."))
	_log(doc, f"{label}: {steps[idx]}", f"{label}: {steps[new]}", "Forward" if direction == "forward" else "Back",
		 reason)
	doc.set(field, steps[new])
	doc.set(since, now_datetime())
	doc.save()
	_notify(doc, _("{0} status updated: {1}.").format(label, steps[new]))
	return {"name": name, "stage": steps[new]}


@frappe.whitelist()
def move_kseb(name, direction="forward", reason=None):
	return _move_track(name, "kseb", direction, reason)


@frappe.whitelist()
def move_subsidy(name, direction="forward", reason=None):
	return _move_track(name, "subsidy", direction, reason)


def _install_blockers(doc):
	blockers = []
	if KSEB.index(doc.kseb_stage or "Not Started") < 2:
		blockers.append(_("KSEB feasibility is not approved yet."))
	if not _invoice_paid(doc.advance_invoice):
		blockers.append(_("Advance invoice {0} is not fully paid.").format(doc.advance_invoice or "-"))
	return blockers


@frappe.whitelist()
def start_installation(name, installer=None):
	doc = _get(name, "Approvals")
	blockers = _install_blockers(doc)
	if blockers:
		frappe.throw("<br>".join(blockers), title=_("Installation locked"))
	if installer:
		doc.installer = installer
	if not doc.installer:
		frappe.throw(_("Pick an installer."))
	_set_stage(doc, "Installation")
	doc.save()
	from frappe.desk.form.assign_to import add as assign

	assign({"assign_to": [doc.installer], "doctype": "Solar Project", "name": name,
			"description": _("Install {0} kW at {1}").format(doc.system_kw, doc.customer_name)})
	_notify(doc, _("Your installation is scheduled. Our team will contact you."))
	return {"name": name}


# ---------------------------------------------------------------- installation / commissioning
@frappe.whitelist()
def toggle_check(name, check_item, done=1):
	doc = _get(name, "Installation")
	row = next((c for c in doc.install_checks if c.check_item == check_item), None)
	if not row:
		frappe.throw(_("Unknown check {0}.").format(check_item))
	row.done = cint(done)
	row.done_by = frappe.session.user if row.done else None
	row.done_on = now_datetime() if row.done else None
	doc.save()
	return {"name": name}


@frappe.whitelist()
def complete_installation(name):
	doc = _get(name, "Installation")
	pending = [c.check_item for c in doc.install_checks if not c.done]
	if pending:
		frappe.throw(_("Pending checks: {0}").format(", ".join(pending)), title=_("Installation incomplete"))
	_make_invoice(doc, _settings(), "installation")
	_set_stage(doc, "Commissioning")
	doc.save()
	_notify(doc, _("Installation completed. Installation milestone invoice raised."))
	return {"name": name}


@frappe.whitelist()
def complete_commissioning(name, commission_date=None, first_generation=None, customer_signature=None):
	doc = _get(name, "Commissioning")
	if doc.kseb_stage != "Synchronised":
		frappe.throw(_("KSEB net-meter is not synchronised yet (now: {0}).").format(doc.kseb_stage),
					 title=_("Commissioning locked"))
	sig = customer_signature or doc.customer_signature
	if not sig:
		frappe.throw(_("Capture the customer's signature."))
	doc.customer_signature = sig
	doc.commission_date = commission_date or nowdate()
	doc.first_generation = first_generation
	doc.next_service_date = add_months(getdate(doc.commission_date), 6)
	_make_invoice(doc, _settings(), "final")
	_set_stage(doc, "AMC")
	doc.save()
	_notify(doc, _("Your solar system is commissioned. First service due {0}.").format(
		frappe.utils.formatdate(doc.next_service_date)))
	return {"name": name}


@frappe.whitelist()
def record_service(name, notes):
	doc = _get(name, "AMC")
	if not notes:
		frappe.throw(_("Write what was done in the service visit."))
	doc.add_comment("Info", _("AMC service visit: {0}").format(notes))
	doc.next_service_date = add_months(getdate(nowdate()), 6)
	doc.save()
	return {"name": name}


# ---------------------------------------------------------------- moving back
def _previous_stage(doc):
	if doc.stage == "Lost":
		last = next((r for r in reversed(doc.stage_log) if r.to_stage == "Lost"), None)
		return last.from_stage if last else "Lead"
	idx = STAGES.index(doc.stage)
	if idx == 0:
		frappe.throw(_("Lead is the first stage."))
	prev = STAGES[idx - 1]
	if prev == "Loan" and not doc.loan_required:
		prev = "Quotation"
	return prev


def _drop_draft_invoice(doc, key):
	"""Draft milestone invoice is deleted on move back; a submitted one blocks the move."""
	field = INVOICE_FIELDS[key]
	si = doc.get(field)
	if not si or not frappe.db.exists("Sales Invoice", si):
		doc.set(field, None)
		return None
	status = frappe.db.get_value("Sales Invoice", si, "docstatus")
	if status == 1:
		frappe.throw(
			_("{0} invoice {1} is submitted. Cancel its payment and the invoice in ERPNext first, then move back.")
			.format(INVOICE_LABEL[key], si),
			title=_("Cannot move back"),
		)
	doc.set(field, None)
	return si if status == 0 else None


@frappe.whitelist()
def move_back(name, reason):
	doc = frappe.get_doc("Solar Project", name)
	doc.check_permission("write")
	if not (reason or "").strip():
		frappe.throw(_("Give a reason for moving back."))
	cur = doc.stage
	prev = _previous_stage(doc)

	if not _is_manager():
		last_fwd = next((r for r in reversed(doc.stage_log) if r.to_stage == cur and r.direction == "Forward"), None)
		if not last_fwd or last_fwd.user != frappe.session.user or getdate(last_fwd.on) != getdate(nowdate()):
			frappe.throw(
				_("Only a Solar Manager can move a project back, unless you made the move yourself today."),
				frappe.PermissionError,
			)

	drafts = []
	if cur in ("Loan", "Paper Work") and prev == "Quotation":
		drafts.append(_drop_draft_invoice(doc, "advance"))
		if doc.sales_order and frappe.db.get_value("Sales Order", doc.sales_order, "docstatus") == 1:
			frappe.throw(
				_("Sales Order {0} is submitted. Cancel it in ERPNext, then move back.").format(doc.sales_order),
				title=_("Cannot move back"),
			)
		if doc.sales_order and frappe.db.get_value("Sales Order", doc.sales_order, "docstatus") == 2:
			doc.sales_order = None
		q_status = frappe.db.get_value("Quotation", doc.quotation, "docstatus") if doc.quotation else None
		if q_status == 1:
			frappe.throw(
				_("Quotation {0} is submitted. Cancel it in ERPNext, then move back.").format(doc.quotation),
				title=_("Cannot move back"),
			)
		if q_status == 2:
			doc.quotation = None
	elif cur == "Approvals":
		if KSEB.index(doc.kseb_stage or "Not Started") > 1 or SUBSIDY.index(doc.subsidy_stage or "Not Started") > 1:
			frappe.throw(_("Move the KSEB and Subsidy boards back to their first step first."),
						 title=_("Cannot move back"))
		doc.kseb_stage, doc.subsidy_stage = "Not Started", "Not Started"
		doc.kseb_stage_since = doc.subsidy_stage_since = None
	elif cur == "Commissioning":
		drafts.append(_drop_draft_invoice(doc, "installation"))
	elif cur == "AMC":
		drafts.append(_drop_draft_invoice(doc, "final"))
	elif cur == "Quotation" and doc.quotation:
		if frappe.db.get_value("Quotation", doc.quotation, "docstatus") == 1:
			frappe.throw(_("Quotation {0} is submitted.").format(doc.quotation), title=_("Cannot move back"))
	elif cur == "Lost":
		doc.lost_reason = None

	_set_stage(doc, prev, "Back", reason)
	doc.save()
	for si in filter(None, drafts):
		frappe.delete_doc("Sales Invoice", si)
	doc.add_comment("Info", _("Moved back from {0} to {1}: {2}").format(cur, prev, reason))
	return {"name": name, "stage": prev}


# ---------------------------------------------------------------- setup health check
@frappe.whitelist()
def setup_check():
	s = _settings()
	out = []

	def add(ok, label, fix=""):
		out.append({"ok": bool(ok), "label": label, "fix": "" if ok else fix})

	add(s.company, "Company set in Solar X Settings", "Open Solar X Settings and pick the Company.")
	item = frappe.db.get_value("Item", s.solar_item, ["is_stock_item", "stock_uom", "disabled"], as_dict=True) \
		if s.solar_item else None
	add(item, "Solar System Item exists", "Create a non-stock Item (e.g. 'Rooftop Solar System', UOM kW) and set it.")
	if item:
		add(not item.disabled, "Solar item is enabled", "Enable the item.")
		add(not item.is_stock_item, "Solar item is non-stock",
			"Untick 'Maintain Stock', or Sales Orders/Invoices will need warehouses and stock.")
		whole = frappe.db.get_value("UOM", item.stock_uom, "must_be_whole_number")
		add(not whole, f"UOM '{item.stock_uom}' allows decimals",
			"Use a UOM like 'kW' without 'Must be Whole Number', or 5.5 kW quotes will fail.")
	group = s.customer_group or frappe.db.get_single_value("Selling Settings", "customer_group")
	terr = s.territory or frappe.db.get_single_value("Selling Settings", "territory")
	add(group, "Default Customer Group", "Set Customer Group in Solar X Settings.")
	add(terr, "Default Territory", "Set Territory in Solar X Settings.")
	add(flt(s.default_price_per_kw) > 0, "Default price per kW", "Set a default price per kW.")
	total = flt(s.advance_percent) + flt(s.installation_percent) + flt(s.final_percent)
	add(abs(total - 100) < 0.01, "Payment milestones add up to 100%", f"Currently {total}%.")
	if s.company:
		add(frappe.db.get_value("Company", s.company, "default_receivable_account"),
			"Company has a default receivable account", "Set Default Receivable Account on the Company.")
		fy = frappe.db.sql(
			"select name from `tabFiscal Year` where %s between year_start_date and year_end_date and disabled=0",
			nowdate())
		add(fy, "Fiscal year covers today", "Create a Fiscal Year for today's date.")
		if s.mode_of_payment:
			acc = frappe.db.get_value("Mode of Payment Account",
									  {"parent": s.mode_of_payment, "company": s.company}, "default_account")
			add(acc, f"Mode of Payment '{s.mode_of_payment}' has an account for {s.company}",
				"Open the Mode of Payment and add a default account for this company.")
		else:
			add(False, "Default Mode of Payment", "Set Default Mode of Payment in Solar X Settings.")
		if s.taxes_template:
			add(frappe.db.get_value("Sales Taxes and Charges Template", s.taxes_template, "company") == s.company,
				"Taxes template belongs to the company", "Pick a template of this company.")
	for role in SOLAR_ROLES:
		users = frappe.db.count("Has Role", {"role": role, "parenttype": "User"})
		add(users, f"At least one user has role '{role}'", f"Give some user the '{role}' role.")
	add(all(frappe.db.exists("Lead Source", x) for x in ["Walk-in", "Facebook", "IndiaMART", "Referral", "Website"]),
		"Lead Sources exist", "Run bench migrate (creates them).")
	return out
