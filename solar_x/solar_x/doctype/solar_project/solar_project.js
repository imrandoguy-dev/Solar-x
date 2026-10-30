frappe.ui.form.on("Solar Project", {
	refresh(frm) {
		frm.add_custom_button(__("Open in Solar X"), () => {
			frappe.route_options = { project: frm.doc.name };
			frappe.set_route("solar-x");
		});
	},
});
