import frappe

# Roles that can see every Solar Project
FULL_ACCESS = {"System Manager", "Solar Manager", "Solar Sales", "Solar Accounts", "Administrator"}


def _field_only(user):
    roles = set(frappe.get_roles(user))
    return not (roles & FULL_ACCESS)


def solar_project_query(user=None):
    user = user or frappe.session.user
    if user == "Administrator" or not _field_only(user):
        return ""
    u = frappe.db.escape(user)
    return f"(`tabSolar Project`.surveyor = {u} or `tabSolar Project`.installer = {u})"


def solar_project_has_permission(doc, ptype=None, user=None):
    user = user or frappe.session.user
    if user == "Administrator" or not _field_only(user):
        return True
    return user in (doc.surveyor, doc.installer)
