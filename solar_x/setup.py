import frappe

SOLAR_ROLES = ["Solar Manager", "Solar Sales", "Solar Surveyor", "Solar Installer", "Solar Accounts"]
LEAD_SOURCES = ["Walk-in", "Facebook", "IndiaMART", "Referral", "Website"]


def ensure_masters():
    """Idempotent: create the roles and ERPNext Lead Sources Solar X relies on."""
    for role in SOLAR_ROLES:
        if not frappe.db.exists("Role", role):
            frappe.get_doc({"doctype": "Role", "role_name": role, "desk_access": 1}).insert(
                ignore_permissions=True
            )
    if frappe.db.table_exists("Lead Source"):
        for src in LEAD_SOURCES:
            if not frappe.db.exists("Lead Source", src):
                frappe.get_doc({"doctype": "Lead Source", "source_name": src}).insert(ignore_permissions=True)
    frappe.db.commit()
