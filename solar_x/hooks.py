app_name = "solar_x"
app_title = "Solar X"
app_publisher = "Hipersign ERP"
app_description = "Rooftop solar EPC workflow (lead to AMC) on top of ERPNext"
app_email = "admin@hipersignerp.com"
app_license = "mit"

required_apps = ["erpnext"]

# Shows a "Solar X" tile on the apps screen
add_to_apps_screen = [
    {
        "name": "solar_x",
        "logo": "/assets/solar_x/images/solar_x.svg",
        "title": "Solar X",
        "route": "/app/solar-x",
    }
]

# Roles must exist before the DocTypes / Page that reference them are synced
before_install = "solar_x.setup.ensure_masters"
after_install = "solar_x.setup.ensure_masters"
after_migrate = "solar_x.setup.ensure_masters"

# Surveyors and installers only see the projects assigned to them
permission_query_conditions = {
    "Solar Project": "solar_x.permissions.solar_project_query",
}
has_permission = {
    "Solar Project": "solar_x.permissions.solar_project_has_permission",
}
