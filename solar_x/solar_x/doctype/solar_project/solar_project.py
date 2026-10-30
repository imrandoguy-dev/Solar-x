import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, now_datetime


def subsidy_for(kw):
	"""PM Surya Ghar residential slab: 30,000/kW for first 2 kW, 18,000 for the 3rd kW, max 78,000."""
	kw = flt(kw)
	return min(78000, min(kw, 2) * 30000 + max(0, min(kw - 2, 1)) * 18000)


class SolarProject(Document):
	def validate(self):
		self.mobile_no = re.sub(r"[^\d+]", "", self.mobile_no or "")
		if not self.mobile_no:
			frappe.throw(_("Mobile number is required."))
		if not self.company:
			self.company = frappe.db.get_single_value("Solar X Settings", "company")
		if not self.stage_since:
			self.stage_since = now_datetime()
		if not self.price_per_kw:
			self.price_per_kw = frappe.db.get_single_value("Solar X Settings", "default_price_per_kw")
		self.project_value = flt(self.system_kw) * flt(self.price_per_kw)
		self.subsidy_amount = subsidy_for(self.system_kw)
		self.check_duplicate_mobile()

	def check_duplicate_mobile(self):
		dup = frappe.db.get_value(
			"Solar Project",
			{"mobile_no": self.mobile_no, "name": ["!=", self.name], "stage": ["!=", "Lost"]},
			"name",
		)
		if dup:
			frappe.throw(
				_("Mobile {0} already belongs to Solar Project {1}.").format(self.mobile_no, dup),
				title=_("Duplicate customer"),
			)
