import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class SolarXSettings(Document):
	def validate(self):
		total = flt(self.advance_percent) + flt(self.installation_percent) + flt(self.final_percent)
		if abs(total - 100) > 0.001:
			frappe.throw(_("Payment milestones must add up to 100% (currently {0}%).").format(total))
		if self.taxes_template and self.company:
			tpl_company = frappe.db.get_value("Sales Taxes and Charges Template", self.taxes_template, "company")
			if tpl_company and tpl_company != self.company:
				frappe.throw(
					_("Taxes template {0} belongs to {1}, not {2}.").format(
						self.taxes_template, tpl_company, self.company
					)
				)
