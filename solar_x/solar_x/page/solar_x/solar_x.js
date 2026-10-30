/* Solar X - full-screen solar EPC app on top of ERPNext.
 * Every button calls solar_x.api.* ; ERPNext validation errors are shown as-is
 * (that is deliberate: this build exists to surface real integration issues). */

frappe.pages["solar-x"].on_page_load = function (wrapper) {
	window.SX = new SolarX(wrapper);
};
frappe.pages["solar-x"].on_page_show = function () {
	if (window.SX) window.SX.show();
};

const SX_STAGES = ["Lead", "Site Visit", "Quotation", "Loan", "Paper Work", "Approvals", "Installation", "Commissioning", "AMC"];
const SX_LABEL = { Approvals: "KSEB & Subsidy" };
const SX_KSEB = ["Not Started", "Application Submitted", "Feasibility Approved", "Inspection", "Meter Installation", "Synchronised"];
const SX_SUB = ["Not Started", "Registered", "Applied", "Inspection", "Redeemed"];
const SX_ROLE_OF = {
	Lead: "Solar Sales", "Site Visit": "Solar Surveyor", Quotation: "Solar Sales", Loan: "Solar Accounts",
	"Paper Work": "Solar Sales", Approvals: "Solar Sales", Installation: "Solar Installer",
	Commissioning: "Solar Installer", AMC: "Solar Installer",
};
const SX_NAV = [
	{ k: "home", label: "Home", ic: "⌂", roles: "*" },
	{ k: "leads", label: "Leads", ic: "♧", roles: ["Solar Sales"] },
	{ k: "projects", label: "Solar Projects", ic: "☀", roles: "*" },
	{ k: "kseb", label: "KSEB Board", ic: "ϟ", roles: ["Solar Sales", "Solar Accounts"] },
	{ k: "subsidy", label: "Subsidy Board", ic: "₹", roles: ["Solar Sales", "Solar Accounts"] },
	{ k: "quote", label: "Quick Quote", ic: "▤", roles: ["Solar Sales"] },
	{ k: "accounts", label: "Payments", ic: "◈", roles: ["Solar Accounts"] },
	{ k: "workflow", label: "Workflow", ic: "⇢", roles: "*" },
	{ k: "setup", label: "Setup Check", ic: "⚙", roles: ["Solar Manager", "System Manager"] },
];

class SolarX {
	constructor(wrapper) {
		this.wrapper = wrapper;
		this.$w = $(wrapper);
		this.page = "home";
		this.view = null; // role preview for managers
		this.project = null; // detail of open project
		this.q = { bill: 4500, units: 0, kw: 0, price: 0 };
		this.filters = { search: "", lost: false };
		this.fullscreen();
		this.load();
	}

	/* ------------------------------------------------ shell */
	fullscreen() {
		$("body").addClass("sx-full");
		if (!this._routeBound) {
			this._routeBound = true;
			frappe.router.on("change", () => {
				const r = frappe.get_route();
				if (r && r[0] === "solar-x") $("body").addClass("sx-full");
				else $("body").removeClass("sx-full");
			});
		}
	}
	show() {
		this.fullscreen();
		const ro = frappe.route_options;
		if (ro && ro.project) {
			frappe.route_options = null;
			this.open(ro.project);
		} else if (this.B) this.load();
	}
	async call(method, args = {}, freeze = true) {
		const r = await frappe.call({ method: "solar_x.api." + method, args, freeze, freeze_message: __("Working...") });
		return r.message;
	}
	async load() {
		try {
			this.B = await this.call("bootstrap", {}, false);
		} catch (e) {
			this.$w.html(`<div class="sx"><div class="sx-page"><h1>Solar X</h1><p class="sx-sub">${__("Could not load. Check the error message and Solar X Settings.")}</p></div></div>`);
			return;
		}
		if (this.project) await this.refreshProject(false);
		else this.render();
	}
	async act(method, args, msg, undoName) {
		try {
			const r = await this.call(method, args);
			if (r && r.duplicate) {
				frappe.msgprint(__("This mobile number already exists on {0}.", [r.duplicate]));
				return this.open(r.duplicate);
			}
			if (undoName) this.undoToast(msg, undoName);
			else if (msg) frappe.show_alert({ message: msg, indicator: "green" });
			await this.load();
			return r;
		} catch (e) {
			/* frappe has already shown the server error dialog */
			return null;
		}
	}
	undoToast(msg, name) {
		$(".sx-toast").remove();
		const $t = $(`<div class="sx-toast">✓ ${frappe.utils.escape_html(msg)} <button>${__("Undo")}</button></div>`).appendTo("body");
		$t.find("button").on("click", () => {
			$t.remove();
			this.act("move_back", { name, reason: "Undo - moved by mistake" }, __("Moved back"));
		});
		setTimeout(() => $t.remove(), 10000);
	}

	/* ------------------------------------------------ helpers */
	esc(s) { return frappe.utils.escape_html(s == null ? "" : String(s)); }
	money(n) { return format_currency(n || 0, (this.B && this.B.settings.currency) || "INR", 0); }
	date(d) { return d ? frappe.datetime.str_to_user(String(d).slice(0, 10)) : "—"; }
	ini(s) { return String(s || "SX").split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase(); }
	slug(dt) { return dt.toLowerCase().replace(/ /g, "-"); }
	link(dt, name) { return name ? `<a class="sx-link" target="_blank" href="/app/${this.slug(dt)}/${encodeURIComponent(name)}">${this.esc(name)}</a>` : "—"; }
	label(st) { return SX_LABEL[st] || st; }
	roles() { return this.view ? [this.view] : this.B.roles; }
	has(role) { const r = this.roles(); return r.includes(role) || (!this.view && this.B.is_manager); }
	canAct(stage) { return this.has(SX_ROLE_OF[stage]); }
	userName(u) {
		for (const k in this.B.team) { const x = this.B.team[k].find((t) => t.user === u); if (x) return x.full_name || u; }
		return u || "—";
	}
	teamOpts(role, sel) {
		return (this.B.team[role] || []).map((u) => `<option value="${this.esc(u.user)}" ${u.user === sel ? "selected" : ""}>${this.esc(u.full_name || u.user)}</option>`).join("");
	}
	P() { return this.B.projects; }
	live() { return this.P().filter((p) => p.stage !== "Lost"); }
	badge(p) {
		if (p.stage === "Lost") return `<span class="sx-bd">Lost</span>`;
		if (p.stage === "Approvals" && p.kseb_overdue) return `<span class="sx-bd r">KSEB overdue</span>`;
		if (p.stage === "Approvals" && p.sub_overdue) return `<span class="sx-bd r">Subsidy overdue</span>`;
		if (p.overdue) return `<span class="sx-bd r">Overdue</span>`;
		return `<span class="sx-bd ${p.stage === "AMC" ? "g" : "t"}">${this.esc(this.label(p.stage))}</span>`;
	}
	kpi(l, v, f, cls = "") { return `<div class="sx-card"><div class="sx-kl">${l}</div><div class="sx-kv ${cls}">${v}</div><div class="sx-kf">${f}</div></div>`; }
	row(p, extra = "") {
		return `<div class="sx-pr"><div class="sx-pa">${this.ini(p.customer_name)}</div><div class="sx-grow"><div class="sx-pn">${this.esc(p.customer_name)}</div><div class="sx-mini">${p.name} · ${p.system_kw || "?"} kW · ${this.esc(p.place || "")}</div></div>${extra || this.badge(p)}<button class="sx-btn s" onclick="SX.open('${p.name}')">Open</button></div>`;
	}
	val(sel) { const el = this.$w.find(sel)[0]; return el ? el.value : null; }
	go(page) { this.page = page; this.project = null; this.render(); }

	/* ------------------------------------------------ render */
	render() {
		const B = this.B;
		const nav = SX_NAV.filter((n) => n.roles === "*" || n.roles.some((r) => this.has(r)));
		const leadsOpen = this.live().filter((p) => p.stage === "Lead").length;
		const viewSel = B.is_manager
			? `<span class="sx-eb">VIEW AS</span><select class="sx-sel" onchange="SX.setView(this.value)"><option value="">My roles</option>${["Solar Sales", "Solar Surveyor", "Solar Installer", "Solar Accounts"].map((r) => `<option ${this.view === r ? "selected" : ""}>${r}</option>`).join("")}</select>`
			: "";
		const crumb = this.project ? `Solar Projects / <b>${this.esc(this.project.customer_name)}</b>` : `<b>${(nav.find((n) => n.k === this.page) || nav[0]).label}</b>`;
		this.$w.html(`<div class="sx">
			<aside class="sx-side">
				<div class="sx-brand"><div class="sx-logo">☀</div><div><div class="sx-bname">solar<span>x</span></div><div class="sx-bsub">EPC · ${this.esc(B.settings.company || "")}</div></div></div>
				<div class="sx-nl">WORKSPACE</div>
				<nav class="sx-nav">${nav.map((n) => `<button class="${!this.project && this.page === n.k ? "on" : ""}" onclick="SX.go('${n.k}')"><span class="ic">${n.ic}</span>${n.label}${n.k === "leads" && leadsOpen ? `<span class="ct">${leadsOpen}</span>` : ""}${n.k === "setup" && B.setup_problems ? `<span class="ct">${B.setup_problems}</span>` : ""}</button>`).join("")}</nav>
				<div class="sx-side-foot">
					${B.setup_problems && B.is_manager ? `<div class="sx-lock" style="margin:0">⚠ ${B.setup_problems} setup problem(s). <a class="sx-link" onclick="SX.go('setup')">Check</a></div>` : ""}
					<button class="sx-btn b" onclick="window.location.href='/app'">↩ ERP Desk</button>
				</div>
			</aside>
			<main class="sx-main">
				<header class="sx-top"><div class="sx-crumb">Solar X / ${crumb}</div>
					<div class="sx-topr">${viewSel}<button class="sx-btn s" onclick="SX.load()" title="Refresh">⟳</button><div class="sx-av" title="${this.esc(B.full_name)}">${this.ini(B.full_name)}</div></div></header>
				<div class="sx-page" id="sx-page"></div>
			</main></div>`);
		const $p = this.$w.find("#sx-page");
		if (this.project) return $p.html(this.cockpit()), this.afterCockpit();
		const fn = {
			home: "home", leads: "leads", projects: "projects", kseb: "kseb", subsidy: "subsidy",
			quote: "quote", accounts: "accounts", workflow: "workflow", setup: "setup",
		}[this.page] || "home";
		$p.html(this[fn]());
		if (this._fs) { const i = this.$w.find("#sx-search")[0]; this._fs = 0; if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
		if (fn === "setup") this.loadSetup();
		if (fn === "quote") this.calc();
	}
	setView(v) { this.view = v || null; this.page = "home"; this.project = null; this.render(); }
	head(t, s, a = "") { return `<div class="sx-h"><div><h1>${t}</h1><p class="sx-sub">${s}</p></div><div class="sx-row">${a}</div></div>`; }

	/* ------------------------------------------------ home */
	home() {
		const r = this.roles();
		if (this.view === "Solar Surveyor" || (!this.B.is_manager && r.length === 1 && r[0] === "Solar Surveyor")) return this.fieldHome("Site Visit", "Site visits", "surveyor");
		if (this.view === "Solar Installer" || (!this.B.is_manager && r.length === 1 && r[0] === "Solar Installer")) return this.fieldHome(["Installation", "Commissioning"], "Installation jobs", "installer");
		if (this.view === "Solar Accounts") return this.accounts();
		const live = this.live();
		const active = live.filter((p) => !["Lead", "AMC"].includes(p.stage));
		const week = frappe.datetime.add_days(frappe.datetime.get_today(), -7);
		const leadsWeek = this.P().filter((p) => String(p.creation).slice(0, 10) >= week).length;
		const ksebOd = live.filter((p) => p.stage === "Approvals" && p.kseb_overdue).length;
		const outstanding = live.reduce((s, p) => s + Object.values(p.milestones || {}).reduce((a, m) => a + (m.docstatus === 1 ? m.outstanding : 0), 0), 0);
		const stuck = live.filter((p) => p.overdue || p.kseb_overdue || p.sub_overdue).sort((a, b) => b.days_in_stage - a.days_in_stage);
		const due = live.filter((p) => p.stage === "Lead" && p.follow_up_date && p.follow_up_date <= frappe.datetime.get_today());
		const max = Math.max(1, ...SX_STAGES.map((s) => live.filter((p) => p.stage === s).length));
		return this.head(`${__("Hello")}, ${this.esc(this.B.full_name.split(" ")[0])} 👋`, __("Live data from ERPNext. Every number opens the records behind it."),
			`<button class="sx-btn" onclick="SX.go('workflow')">⇢ Workflow</button><button class="sx-btn p" onclick="SX.newLead()">＋ New Lead</button>`) +
			`<div class="sx-grid sx-kpis">${this.kpi("Active projects", active.length, "Site visit to commissioning")}${this.kpi("Leads this week", leadsWeek, "Created in last 7 days")}${this.kpi("Overdue KSEB files", ksebOd, "Beyond stage SLA", ksebOd ? "sx-red" : "")}${this.kpi("Outstanding on invoices", this.money(outstanding), "Submitted, unpaid milestones", "sx-teal")}</div>
			<div class="sx-split"><section class="sx-card"><div class="sx-sh"><div><h2>Needs attention</h2><p class="sx-mini">Beyond SLA</p></div><span class="sx-bd r">${stuck.length} flagged</span></div>
			${stuck.slice(0, 8).map((p) => this.row(p, `<span class="sx-bd r">${p.stage === "Approvals" ? (p.kseb_overdue ? `KSEB ${p.kseb_days}d` : `Subsidy ${p.sub_days}d`) : `${p.days_in_stage}d / ${p.sla}d`}</span>`)).join("") || `<div class="sx-empty">All on time.</div>`}
			${due.length ? `<div class="sx-div"></div><h3>Follow-ups due</h3>${due.slice(0, 5).map((p) => this.row(p)).join("")}` : ""}</section>
			<section class="sx-card"><div class="sx-sh"><div><h2>Pipeline</h2><p class="sx-mini">Projects by stage</p></div><button class="sx-btn s" onclick="SX.go('projects')">View all</button></div>
			<div class="sx-pipe">${SX_STAGES.map((s) => { const c = live.filter((p) => p.stage === s).length; return `<div class="sx-pc" onclick="SX.filters.stage='${s}';SX.go('projects')"><b>${c}</b><div class="sx-pb" style="height:${Math.max(4, (c / max) * 80)}px;opacity:${c ? 1 : 0.3}"></div><div class="sx-pl">${this.label(s)}</div></div>`; }).join("")}</div></section></div>`;
	}
	fieldHome(stage, title, field) {
		const stages = [].concat(stage);
		const jobs = this.live().filter((p) => stages.includes(p.stage) && (this.view || p[field] === this.B.user || this.B.is_manager));
		return this.head(title, __("Your assigned jobs."), `<span class="sx-bd t">${jobs.length} jobs</span>`) +
			`<div class="sx-grid" style="grid-template-columns:repeat(auto-fill,minmax(270px,1fr))">${jobs.map((p) => `<div class="sx-card"><div class="sx-sh">${this.badge(p)}<span class="sx-mini">${p.system_kw || "?"} kW</span></div><h2>${this.esc(p.customer_name)}</h2><p class="sx-mini">${p.name} · ${this.esc(p.place || "")}</p><p style="margin:10px 0" class="sx-mini">📍 ${this.esc(p.address || "Address pending")}${p.visit_date ? ` · Visit ${this.date(p.visit_date)}` : ""}</p><button class="sx-btn p b" onclick="SX.open('${p.name}')">Open →</button></div>`).join("") || `<div class="sx-card sx-empty">${__("Nothing assigned right now.")}</div>`}</div>`;
	}

	/* ------------------------------------------------ leads */
	leads() {
		const q = this.filters.search.toLowerCase();
		const rows = this.P().filter((p) => (this.filters.lost ? p.stage === "Lost" : p.stage === "Lead") && `${p.customer_name} ${p.mobile_no} ${p.place} ${p.name}`.toLowerCase().includes(q));
		const today = frappe.datetime.get_today();
		return this.head("Leads", __("Every enquiry becomes an ERPNext Lead + a Solar Project. Customer details are never typed twice."),
			`<button class="sx-btn" onclick="SX.go('quote')">⚡ Quick Quote</button><button class="sx-btn p" onclick="SX.newLead()">＋ New Lead</button>`) +
			`<div class="sx-tool"><input class="sx-in" style="flex:1;min-width:200px" placeholder="Search name, mobile, place or ID" value="${this.esc(this.filters.search)}" id="sx-search" oninput="SX.filters.search=this.value;SX._fs=1;clearTimeout(SX._t);SX._t=setTimeout(()=>SX.render(),300)">
			<button class="sx-btn ${this.filters.lost ? "" : "p"}" onclick="SX.filters.lost=false;SX.render()">Open</button><button class="sx-btn ${this.filters.lost ? "p" : ""}" onclick="SX.filters.lost=true;SX.render()">Lost</button></div>
			<div class="sx-tw"><table><thead><tr><th>Customer</th><th>Place / Source</th><th>Bill</th><th>Sales</th><th>Follow-up</th><th>Status</th><th>ERPNext Lead</th></tr></thead><tbody>
			${rows.map((p) => `<tr class="ck" onclick="SX.open('${p.name}')"><td><b>${this.esc(p.customer_name)}</b><div class="sx-mini">${p.name} · ${this.esc(p.mobile_no)}</div></td><td>${this.esc(p.place || "")}<div class="sx-mini">${this.esc(p.source || "")}</div></td><td>${this.money(p.monthly_bill)}</td><td>${this.esc(this.userName(p.sales_person))}</td><td class="${p.follow_up_date && p.follow_up_date < today && p.stage === "Lead" ? "sx-red" : ""}">${this.date(p.follow_up_date)}</td><td>${p.stage === "Lost" ? `<span class="sx-bd">${this.esc(p.lost_reason || "Lost")}</span>` : `<span class="sx-bd t">${this.esc(p.lead_status || "New")}</span>`}</td><td onclick="event.stopPropagation()">${this.link("Lead", p.lead)}</td></tr>`).join("") || `<tr><td colspan="7" class="sx-empty">No leads.</td></tr>`}
			</tbody></table></div>`;
	}
	newLead(pre = {}) {
		const d = new frappe.ui.Dialog({
			title: __("New Lead"),
			fields: [
				{ fieldname: "customer_name", label: "Customer Name", fieldtype: "Data", reqd: 1, default: pre.customer_name },
				{ fieldname: "mobile_no", label: "Mobile", fieldtype: "Data", options: "Phone", reqd: 1 },
				{ fieldname: "place", label: "Place", fieldtype: "Data" },
				{ fieldtype: "Column Break" },
				{ fieldname: "monthly_bill", label: "Monthly KSEB Bill", fieldtype: "Currency", default: pre.monthly_bill || 4500 },
				{ fieldname: "source", label: "Source", fieldtype: "Select", options: "Walk-in\nFacebook\nIndiaMART\nReferral\nWebsite\nOther", default: "Walk-in" },
				{ fieldname: "sales_person", label: "Sales Person", fieldtype: "Link", options: "User", default: frappe.session.user },
			],
			primary_action_label: __("Create Lead"),
			primary_action: async (v) => {
				d.hide();
				const r = await this.act("create_lead", { ...v, system_kw: pre.system_kw || null }, __("Lead created"));
				if (r && r.name) this.open(r.name);
			},
		});
		d.show();
	}

	/* ------------------------------------------------ projects list */
	projects() {
		const st = this.filters.stage || "";
		const rows = this.P().filter((p) => (!st || p.stage === st) && p.stage !== "Lead");
		return this.head("Solar Projects", __("One record per customer job, from site visit to AMC."), `<button class="sx-btn p" onclick="SX.newLead()">＋ New Lead</button>`) +
			`<div class="sx-tool"><select class="sx-sel" onchange="SX.filters.stage=this.value;SX.render()"><option value="">All stages</option>${SX_STAGES.slice(1).concat(["Lost"]).map((s) => `<option value="${s}" ${st === s ? "selected" : ""}>${this.label(s)}</option>`).join("")}</select></div>
			<div class="sx-tw"><table><thead><tr><th>Customer</th><th>Place</th><th>System</th><th>Stage</th><th>Value</th><th>Received</th><th>Days in stage</th></tr></thead><tbody>
			${rows.map((p) => `<tr class="ck" onclick="SX.open('${p.name}')"><td><b>${this.esc(p.customer_name)}</b><div class="sx-mini">${p.name}</div></td><td>${this.esc(p.place || "")}</td><td>${p.system_kw || "—"} kW</td><td>${this.badge(p)}</td><td>${this.money(p.project_value)}</td><td>${this.money(p.received)}</td><td>${p.days_in_stage}${p.sla ? ` / ${p.sla}` : ""}</td></tr>`).join("") || `<tr><td colspan="7" class="sx-empty">No projects${st ? " in this stage" : ""}.</td></tr>`}
			</tbody></table></div>`;
	}

	/* ------------------------------------------------ cockpit */
	async open(name) {
		this.project = { name, customer_name: name };
		await this.refreshProject(true);
	}
	async refreshProject(freeze) {
		try {
			this.project = await this.call("get_project", { name: this.project.name }, freeze);
		} catch (e) {
			this.project = null;
		}
		this.render();
	}
	stepper(d) {
		const cur = SX_STAGES.indexOf(d.stage);
		const lb = this.B.projects.find((p) => p.name === d.name) || {};
		return `<div class="sx-step">${SX_STAGES.map((s, i) => {
			let c = "";
			const skip = s === "Loan" && !d.loan_required && cur > 3;
			if (skip) c = "skip"; else if (d.stage === "Lost") c = ""; else if (i < cur) c = "done"; else if (i === cur) c = "cur" + (lb.overdue ? " od" : "");
			return `<div class="sx-st ${c}"><span class="sx-sc">${skip ? "–" : i < cur && d.stage !== "Lost" ? "✓" : i + 1}</span><span class="sx-sn">${this.label(s)}</span></div>`;
		}).join("")}</div>`;
	}
	cockpit() {
		const d = this.project;
		const lb = this.B.projects.find((p) => p.name === d.name) || {};
		const pct = d.project_value ? Math.min(100, ((lb.received || 0) / d.project_value) * 100) : 0;
		const canBack = d.stage !== "Lead";
		return `<div class="sx-h"><div><button class="sx-btn s" onclick="SX.go('projects')">← All projects</button><h1 style="margin-top:10px">${this.esc(d.customer_name)}</h1><p class="sx-sub">${d.name} · ${this.esc(d.place || "")} · ${d.system_kw || "?"} kW · ${this.esc(d.mobile_no)}</p></div>
			<div class="sx-row">${canBack ? `<button class="sx-btn" onclick="SX.moveBack()">← Move back</button>` : ""}<a class="sx-btn" target="_blank" href="/app/solar-project/${encodeURIComponent(d.name)}">Open form</a></div></div>
			<div class="sx-card" style="margin-bottom:14px"><div class="sx-row" style="justify-content:space-between"><div class="sx-row">${this.badge(lb.name ? lb : d)}<span class="sx-bd">${d.days_in_stage || lb.days_in_stage || 0} days in stage</span></div><div class="sx-row sx-mini">Lead ${this.link("Lead", d.lead)} · Customer ${this.link("Customer", d.customer)} · Quotation ${this.link("Quotation", d.quotation)} · SO ${this.link("Sales Order", d.sales_order)}</div></div>
			<div class="sx-meta"><div><div class="sx-eb">KSEB consumer no.</div><strong>${this.esc(d.kseb_consumer_no || "—")}</strong></div><div><div class="sx-eb">Project value</div><strong>${this.money(d.project_value)}</strong></div><div><div class="sx-eb">Subsidy (est.)</div><strong>${this.money(d.subsidy_amount)}</strong></div><div><div class="sx-eb">Sales</div><strong>${this.esc(this.userName(d.sales_person))}</strong></div><div><div class="sx-eb">Surveyor</div><strong>${this.esc(this.userName(d.surveyor))}</strong></div><div><div class="sx-eb">Installer</div><strong>${this.esc(this.userName(d.installer))}</strong></div></div>
			<div class="sx-pay"><b class="sx-mini" style="margin:0;color:var(--ink)">Received ${this.money(lb.received)} of ${this.money(d.project_value)} (+ tax)</b><div class="sx-prog"><span style="width:${pct}%"></span></div><b>${Math.round(pct)}%</b></div></div>
			${this.stepper(d)}
			<div class="sx-cock"><div>${this.stageCard(d)}</div><aside>${this.billingCard(d, lb)}${this.filesCard(d)}${this.timelineCard(d)}</aside></div>`;
	}
	stageWrap(d, body) {
		const own = d.stage === "Lost" || this.canAct(d.stage);
		const lb = this.B.projects.find((p) => p.name === d.name) || {};
		return `<div class="sx-card"><div class="sx-sh"><div><div class="sx-eb">${d.stage === "Lost" ? "LOST" : `CURRENT STAGE · ${SX_STAGES.indexOf(d.stage) + 1} OF 9`}</div><h2 style="margin-top:5px">${this.label(d.stage)}</h2><p class="sx-mini">${d.stage !== "Lost" ? `Owner: ${SX_ROLE_OF[d.stage]} · SLA ${lb.sla || "—"} days` : ""}</p></div>${lb.overdue ? `<span class="sx-bd r">Overdue</span>` : ""}</div>
			${own ? "" : `<div class="sx-lock">🔒 ${__("Waiting on")} <b>${SX_ROLE_OF[d.stage]}</b>. ${__("You can view this stage; actions will be refused by the server.")}</div>`}${body}</div>`;
	}
	f(label, name, value, type = "text", opts) {
		if (opts) return `<div class="sx-f"><label>${label}</label><select id="sx-${name}">${["", ...opts].map((o) => `<option ${o === value ? "selected" : ""}>${o}</option>`).join("")}</select></div>`;
		return `<div class="sx-f"><label>${label}</label><input id="sx-${name}" type="${type}" value="${this.esc(value == null ? "" : value)}"></div>`;
	}
	stageCard(d) {
		const N = d.name;
		switch (d.stage) {
			case "Lead":
				return this.stageWrap(d, `<div class="sx-info">${this.esc(d.lead_status || "New")} lead from ${this.esc(d.source || "—")} · monthly bill ${this.money(d.monthly_bill)} · follow up ${this.date(d.follow_up_date)}</div>
					<div class="sx-row" style="margin-top:14px"><button class="sx-btn p" onclick="SX.scheduleVisit()">Schedule site visit →</button><button class="sx-btn" onclick="SX.act('mark_contacted',{name:'${N}'},'Follow-up set')">☎ Mark contacted</button><button class="sx-btn d" onclick="SX.markLost()">Mark lost</button></div>`);
			case "Site Visit":
				return this.stageWrap(d, `<p class="sx-mini" style="margin-bottom:12px">Visit on ${this.date(d.visit_date)} · ${this.esc(this.userName(d.surveyor))}</p><div class="sx-fg">
					${this.f("Roof type", "roof_type", d.roof_type, "", ["RCC", "Tiled", "Metal sheet", "Other"])}${this.f("Phase", "phase", d.phase, "", ["Single phase", "Three phase"])}
					${this.f("Shadow-free area (sq ft)", "shadow_free_area", d.shadow_free_area || "", "number")}${this.f("Connected load", "connected_load", d.connected_load)}
					${this.f("KSEB consumer number", "kseb_consumer_no", d.kseb_consumer_no)}${this.f("KSEB section office", "kseb_section", d.kseb_section)}
					<div class="sx-f sx-full2"><label>Site address</label><textarea id="sx-address" rows="2">${this.esc(d.address || "")}</textarea></div></div>
					<div class="sx-div"></div><div class="sx-sh"><h3>Site photos (min 2)</h3><span class="sx-bd ${d.files.length >= 2 ? "g" : "a"}">${d.files.length} uploaded</span></div>
					<button class="sx-btn" onclick="SX.upload()">📷 Upload photo</button>
					<button class="sx-btn p b" style="margin-top:14px" onclick="SX.completeSurvey()">Complete site visit →</button>`);
			case "Quotation": {
				const kw = d.system_kw || 0, price = d.price_per_kw || this.B.settings.default_price_per_kw;
				return this.stageWrap(d, `<div class="sx-fg">${this.f("System size (kW)", "system_kw", kw, "number")}${this.f("Price per kW", "price_per_kw", price, "number")}
					${this.f("Panel brand", "panel_brand", d.panel_brand || "", "", ["Waaree", "Adani Solar", "Tata Power", "Vikram Solar"])}${this.f("Inverter brand", "inverter_brand", d.inverter_brand || "", "", ["Growatt", "Sungrow", "GoodWe", "Solis"])}</div>
					<div class="sx-info" style="margin-top:14px">Project value ${this.money(kw * price)} (before tax) · Est. subsidy ${this.money(d.subsidy_amount)} · Advance ${this.B.settings.advance_percent}% = ${this.money((kw * price * this.B.settings.advance_percent) / 100)}</div>
					<div class="sx-row" style="margin-top:14px"><button class="sx-btn" onclick="SX.saveQuote()">💾 ${d.quotation ? "Update" : "Create"} ERPNext Quotation</button>
					${d.quotation ? `<a class="sx-btn" target="_blank" href="/printview?doctype=Quotation&name=${encodeURIComponent(d.quotation)}">🖨 Print</a><button class="sx-btn" onclick="SX.sendQuote()">↗ WhatsApp</button><button class="sx-btn p" onclick="SX.accept()">✓ Customer accepted</button>` : ""}
					<button class="sx-btn d" onclick="SX.markLost()">Lost</button></div>
					<p class="sx-mini" style="margin-top:10px">Accepting submits the Quotation, creates + submits a Sales Order and a draft advance Sales Invoice.</p>`);
			}
			case "Loan":
				return this.stageWrap(d, `<div class="sx-fg">${this.f("Bank / finance provider", "loan_bank", d.loan_bank)}${this.f("Loan amount", "loan_amount", d.loan_amount || "", "number")}${this.f("Loan status", "loan_status", d.loan_status, "", ["Applied", "Sanctioned", "Disbursed"])}</div>
					<button class="sx-btn p b" style="margin-top:14px" onclick="SX.act('save_loan',{name:'${N}',loan_bank:SX.val('#sx-loan_bank'),loan_amount:SX.val('#sx-loan_amount'),loan_status:SX.val('#sx-loan_status')},'Loan saved','${N}')">Save loan status</button>
					<p class="sx-mini" style="margin-top:8px">Marking “Disbursed” moves the project to Paper Work.</p>`);
			case "Paper Work":
				return this.stageWrap(d, `${(d.documents || []).map((x) => `<div class="sx-chk ${x.received ? "done" : ""}"><input type="checkbox" ${x.received ? "checked" : ""} onchange="SX.act('set_document',{name:'${N}',document_type:${JSON.stringify(x.document_type).replace(/"/g, "&quot;")},received:this.checked?1:0})"><label>${this.esc(x.document_type)}${x.attachment ? ` · <a class="sx-link" target="_blank" href="${this.esc(x.attachment)}">file</a>` : ""}</label><button class="sx-btn s" onclick="SX.upload(${JSON.stringify(x.document_type).replace(/"/g, "&quot;")})">📎</button></div>`).join("")}
					<button class="sx-btn p b" style="margin-top:8px" ${(d.documents || []).every((x) => x.received) ? "" : "disabled"} onclick="SX.act('complete_paperwork',{name:'${N}'},'Paper work complete','${N}')">Complete paper work →</button>`);
			case "Approvals":
				return this.stageWrap(d, this.trackHtml(d, "kseb") + this.trackHtml(d, "subsidy") + this.installGate(d));
			case "Installation":
				return this.stageWrap(d, `${(d.install_checks || []).map((c) => `<div class="sx-chk ${c.done ? "done" : ""}"><input type="checkbox" ${c.done ? "checked" : ""} onchange="SX.act('toggle_check',{name:'${N}',check_item:${JSON.stringify(c.check_item).replace(/"/g, "&quot;")},done:this.checked?1:0})"><label>${this.esc(c.check_item)}<div class="sx-mini">${c.done ? `✓ ${this.esc(this.userName(c.done_by))} · ${this.esc(String(c.done_on || "").slice(0, 16))}` : "Tap when done"}</div></label></div>`).join("")}
					<button class="sx-btn" onclick="SX.upload()">📸 Upload installation photo</button>
					<button class="sx-btn p b" style="margin-top:12px" ${(d.install_checks || []).every((c) => c.done) ? "" : "disabled"} onclick="SX.act('complete_installation',{name:'${N}'},'Installation complete','${N}')">Complete installation →</button>
					<p class="sx-mini" style="margin-top:8px">Creates the ${this.B.settings.installation_percent}% installation milestone invoice (draft).</p>`);
			case "Commissioning":
				return this.stageWrap(d, `${d.kseb_stage !== "Synchronised" ? `<div class="sx-lock">🔒 KSEB net-meter must be Synchronised (now: ${this.esc(d.kseb_stage)}). ${this.canAct("Approvals") ? `<a class="sx-link" onclick="SX.moveTrack('kseb','forward')">Move KSEB forward</a>` : ""}</div>` : ""}
					${this.trackHtml(d, "kseb")}
					<div class="sx-fg">${this.f("Commission date", "commission_date", d.commission_date || frappe.datetime.get_today(), "date")}${this.f("First generation reading", "first_generation", d.first_generation || "")}</div>
					<div class="sx-f" style="margin-top:12px"><label>Customer signature</label><canvas class="sx-sig" id="sx-sig"></canvas><button class="sx-btn s" style="margin-top:6px;width:max-content" onclick="SX.clearSig()">Clear</button></div>
					<button class="sx-btn p b" style="margin-top:12px" onclick="SX.commission()">Complete commissioning →</button>`);
			case "AMC":
				return this.stageWrap(d, `<div class="sx-info"><div class="sx-eb">Next service due</div><div class="sx-qt">${this.date(d.next_service_date)}</div>Commissioned ${this.date(d.commission_date)} · first reading ${this.esc(d.first_generation || "—")}</div>
					<button class="sx-btn p b" style="margin-top:12px" onclick="SX.service()">Record service visit</button>`);
			case "Lost":
				return this.stageWrap(d, `<div class="sx-info">Lost: ${this.esc(d.lost_reason || "")}</div><button class="sx-btn b" style="margin-top:12px" onclick="SX.moveBack()">↺ Reopen</button>`);
		}
		return "";
	}
	trackHtml(d, track) {
		const steps = track === "kseb" ? SX_KSEB : SX_SUB;
		const cur = steps.indexOf((track === "kseb" ? d.kseb_stage : d.subsidy_stage) || "Not Started");
		const lb = this.B.projects.find((p) => p.name === d.name) || {};
		const days = track === "kseb" ? lb.kseb_days : lb.sub_days, sla = track === "kseb" ? lb.kseb_sla : lb.sub_sla, od = track === "kseb" ? lb.kseb_overdue : lb.sub_overdue;
		return `<div class="sx-sh" style="margin-top:6px"><h3>${track === "kseb" ? "KSEB Net-Metering" : "PM Surya Ghar Subsidy"}</h3><span class="sx-bd ${od ? "r" : "t"}">${days || 0}${sla ? ` / ${sla}` : ""} days</span></div>
			<div class="sx-row" style="margin-bottom:10px">${steps.slice(1).map((s, i) => `<span class="sx-bd ${i + 1 < cur ? "g" : i + 1 === cur ? "t" : ""}">${i + 1 < cur ? "✓ " : ""}${s}</span>`).join("")}</div>
			<div class="sx-row" style="margin-bottom:16px">${cur > 1 ? `<button class="sx-btn s" onclick="SX.moveTrack('${track}','back')">← Back</button>` : ""}${cur < steps.length - 1 ? `<button class="sx-btn s p" onclick="SX.moveTrack('${track}','forward')">Move to ${steps[cur + 1]} →</button>` : ""}</div>`;
	}
	installGate(d) {
		const kOk = SX_KSEB.indexOf(d.kseb_stage) >= 2;
		const adv = (d.invoices || {}).advance;
		const paid = adv && adv.docstatus === 1 && adv.outstanding_amount <= 0.01;
		return `<div class="sx-div"></div><h3>Start installation</h3>
			${!kOk || !paid ? `<div class="sx-lock">🔒 ${!kOk ? "KSEB feasibility not approved yet.<br>" : ""}${!paid ? `Advance invoice ${adv ? this.esc(adv.name) : ""} not fully paid (Payments → Record payment).` : ""}</div>` : `<div class="sx-info">✓ Ready for installation.</div>`}
			<div class="sx-fg" style="margin-top:10px"><div class="sx-f"><label>Installer</label><select id="sx-installer"><option></option>${this.teamOpts("Solar Installer", d.installer)}</select></div></div>
			<button class="sx-btn p b" style="margin-top:12px" onclick="SX.act('start_installation',{name:'${d.name}',installer:SX.val('#sx-installer')},'Installation started','${d.name}')">Start installation →</button>`;
	}
	billingCard(d, lb) {
		const S = this.B.settings;
		const ms = [["advance", "Advance", S.advance_percent], ["installation", "Installation", S.installation_percent], ["final", "Commissioning", S.final_percent]];
		return `<div class="sx-card" style="margin-bottom:14px"><div class="sx-sh"><h3>Billing (ERPNext)</h3></div>${ms.map(([k, l, p]) => {
			const inv = (d.invoices || {})[k];
			const st = !inv ? `<span class="sx-bd">Not raised</span>` : inv.docstatus === 0 ? `<span class="sx-bd a">Draft</span>` : inv.docstatus === 2 ? `<span class="sx-bd">Cancelled</span>` : inv.outstanding_amount <= 0.01 ? `<span class="sx-bd g">Paid</span>` : `<span class="sx-bd r">Due ${this.money(inv.outstanding_amount)}</span>`;
			return `<div class="sx-ms"><div><b>${l} · ${p}%</b><div class="sx-mini">${inv ? this.link("Sales Invoice", inv.name) : this.money((d.project_value * p) / 100)}</div></div><div style="text-align:right">${st}${inv && inv.docstatus !== 2 && !(inv.docstatus === 1 && inv.outstanding_amount <= 0.01) && this.has("Solar Accounts") ? `<div><button class="sx-btn s" style="margin-top:4px" onclick="SX.pay('${d.name}','${k}')">Record payment</button></div>` : ""}</div></div>`;
		}).join("")}</div>`;
	}
	filesCard(d) {
		return `<div class="sx-card" style="margin-bottom:14px"><div class="sx-sh"><h3>Files</h3><button class="sx-btn s" onclick="SX.upload()">＋</button></div>${(d.files || []).map((f) => `<div class="sx-ms"><a class="sx-link" target="_blank" href="${this.esc(f.file_url)}">${this.esc(f.file_name)}</a><span class="sx-mini">${this.date(f.creation)}</span></div>`).join("") || `<div class="sx-mini">No files yet.</div>`}</div>`;
	}
	timelineCard(d) {
		const items = [];
		(d.stage_log || []).forEach((r) => items.push({ t: r.on, bk: r.direction === "Back", h: `${this.esc(r.from_stage ? this.label(r.from_stage) + " → " : "")}${this.esc(this.label(r.to_stage))}${r.reason ? ` <i>(${this.esc(r.reason)})</i>` : ""}`, by: r.user }));
		(d.comments || []).forEach((c) => items.push({ t: c.creation, h: c.content, by: c.owner }));
		items.sort((a, b) => String(b.t).localeCompare(String(a.t)));
		return `<div class="sx-card"><div class="sx-sh"><h3>Activity</h3><span class="sx-bd">${items.length}</span></div>${items.slice(0, 25).map((i) => `<div class="sx-tl"><div class="sx-dot ${i.bk ? "bk" : ""}">${i.bk ? "↩" : "✓"}</div><div class="sx-tt">${i.h}<small>${this.esc(this.userName(i.by))} · ${this.esc(String(i.t || "").slice(0, 16))}</small></div></div>`).join("") || `<div class="sx-mini">No activity.</div>`}</div>`;
	}
	afterCockpit() {
		const c = this.$w.find("#sx-sig")[0];
		if (!c) return;
		c.width = c.offsetWidth; c.height = c.offsetHeight;
		const ctx = c.getContext("2d"); ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.strokeStyle = "#163D35";
		let drawing = false; this._sigDirty = false;
		const pos = (e) => { const r = c.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return [t.clientX - r.left, t.clientY - r.top]; };
		const start = (e) => { drawing = true; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); e.preventDefault(); };
		const move = (e) => { if (!drawing) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); this._sigDirty = true; e.preventDefault(); };
		const end = () => { drawing = false; };
		c.addEventListener("mousedown", start); c.addEventListener("mousemove", move); window.addEventListener("mouseup", end);
		c.addEventListener("touchstart", start); c.addEventListener("touchmove", move); c.addEventListener("touchend", end);
	}
	clearSig() { const c = this.$w.find("#sx-sig")[0]; if (c) { c.getContext("2d").clearRect(0, 0, c.width, c.height); this._sigDirty = false; } }

	/* ------------------------------------------------ stage actions */
	scheduleVisit() {
		const d = this.project;
		const opts = (this.B.team["Solar Surveyor"] || []).map((u) => ({ label: u.full_name || u.user, value: u.user }));
		const dlg = new frappe.ui.Dialog({
			title: __("Schedule site visit"),
			fields: [
				{ fieldname: "visit_date", label: "Visit date", fieldtype: "Date", reqd: 1, default: frappe.datetime.add_days(frappe.datetime.get_today(), 1) },
				opts.length ? { fieldname: "surveyor", label: "Surveyor", fieldtype: "Select", options: opts, reqd: 1 } : { fieldname: "surveyor", label: "Surveyor", fieldtype: "Link", options: "User", reqd: 1, description: "No user has the Solar Surveyor role yet." },
			],
			primary_action_label: __("Confirm visit"),
			primary_action: (v) => { dlg.hide(); this.act("schedule_visit", { name: d.name, ...v }, __("Visit scheduled"), d.name); },
		});
		dlg.show();
	}
	markLost() {
		const d = this.project;
		frappe.prompt([{ fieldname: "reason", label: "Reason", fieldtype: "Select", options: "Price\nCompetitor\nNot interested\nNo roof / shadow\nOther", reqd: 1 }],
			(v) => this.act("mark_lost", { name: d.name, reason: v.reason }, __("Marked lost"), d.name), __("Mark lost"));
	}
	upload(docType) {
		const d = this.project;
		new frappe.ui.FileUploader({
			doctype: "Solar Project", docname: d.name, folder: "Home/Attachments",
			on_success: (file) => {
				if (docType) this.act("set_document", { name: d.name, document_type: docType, received: 1, attachment: file.file_url }, __("Document attached"));
				else this.refreshProject(false);
			},
		});
	}
	completeSurvey() {
		const N = this.project.name;
		this.act("complete_survey", {
			name: N, roof_type: this.val("#sx-roof_type"), phase: this.val("#sx-phase"), shadow_free_area: this.val("#sx-shadow_free_area"),
			connected_load: this.val("#sx-connected_load"), kseb_consumer_no: this.val("#sx-kseb_consumer_no"), kseb_section: this.val("#sx-kseb_section"), address: this.val("#sx-address"),
		}, __("Survey complete"), N);
	}
	saveQuote() {
		this.act("save_quotation", { name: this.project.name, system_kw: this.val("#sx-system_kw"), price_per_kw: this.val("#sx-price_per_kw"), panel_brand: this.val("#sx-panel_brand"), inverter_brand: this.val("#sx-inverter_brand") }, __("Quotation saved"));
	}
	async sendQuote() {
		const r = await this.act("send_quotation", { name: this.project.name }, __("Logged WhatsApp message"));
		if (r) {
			const link = `${window.location.origin}/printview?doctype=Quotation&name=${encodeURIComponent(r.quotation)}`;
			window.open(`https://wa.me/${String(r.mobile_no).replace(/\D/g, "")}?text=${encodeURIComponent("Your solar quotation " + r.quotation + ": " + link)}`, "_blank");
		}
	}
	accept() {
		const N = this.project.name;
		frappe.prompt([{ fieldname: "loan", label: "Customer taking a loan?", fieldtype: "Check" }],
			(v) => this.act("accept_quotation", { name: N, loan_required: v.loan ? 1 : 0 }, __("Quote accepted"), N),
			__("Quotation accepted"), __("Confirm"));
	}
	moveTrack(track, dir) {
		const N = this.project ? this.project.name : null;
		const run = (name, reason) => this.act(track === "kseb" ? "move_kseb" : "move_subsidy", { name, direction: dir, reason }, __("Updated"));
		const name = this._trackTarget || N;
		this._trackTarget = null;
		if (dir === "back") frappe.prompt([{ fieldname: "reason", label: "Why move back?", fieldtype: "Small Text", reqd: 1 }], (v) => run(name, v.reason), __("Move back"));
		else run(name);
	}
	boardMove(name, track, dir) { this._trackTarget = name; this.moveTrack(track, dir); }
	commission() {
		const N = this.project.name;
		const c = this.$w.find("#sx-sig")[0];
		const sig = c && this._sigDirty ? c.toDataURL("image/png") : null;
		this.act("complete_commissioning", { name: N, commission_date: this.val("#sx-commission_date"), first_generation: this.val("#sx-first_generation"), customer_signature: sig }, __("Commissioned"), N);
	}
	service() {
		const N = this.project.name;
		frappe.prompt([{ fieldname: "notes", label: "What was done?", fieldtype: "Small Text", reqd: 1 }], (v) => this.act("record_service", { name: N, notes: v.notes }, __("Service recorded")), __("AMC service visit"));
	}
	moveBack() {
		const d = this.project;
		frappe.prompt([{ fieldname: "reason", label: __("Why move {0} back?", [d.name]), fieldtype: "Small Text", reqd: 1 }],
			(v) => this.act("move_back", { name: d.name, reason: v.reason }, __("Moved back")), __("Move back a stage"), __("Move back"));
	}
	pay(name, milestone) {
		const dlg = new frappe.ui.Dialog({
			title: __("Record payment"),
			fields: [
				{ fieldname: "mode_of_payment", label: "Mode of Payment", fieldtype: "Link", options: "Mode of Payment", description: "Blank = default from Solar X Settings" },
				{ fieldname: "reference_no", label: "Reference / UTR No", fieldtype: "Data" },
			],
			primary_action_label: __("Submit invoice & payment"),
			primary_action: (v) => { dlg.hide(); this.act("record_payment", { name, milestone, ...v }, __("Payment recorded")); },
		});
		dlg.set_message(__("This submits the Sales Invoice (if draft) and creates + submits a Payment Entry for the full outstanding."));
		dlg.show();
	}

	/* ------------------------------------------------ boards */
	board(track) {
		const steps = track === "kseb" ? SX_KSEB : SX_SUB;
		const fld = track === "kseb" ? "kseb_stage" : "subsidy_stage";
		const list = this.live().filter((p) => p[fld] && p[fld] !== "Not Started");
		const odKey = track === "kseb" ? "kseb_overdue" : "sub_overdue", dKey = track === "kseb" ? "kseb_days" : "sub_days", sKey = track === "kseb" ? "kseb_sla" : "sub_sla";
		return `<div class="sx-grid sx-kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">${this.kpi("Active files", list.filter((p) => p[fld] !== steps[steps.length - 1]).length, "In progress")}${this.kpi("Overdue", list.filter((p) => p[odKey]).length, "Beyond SLA", "sx-red")}${this.kpi(steps[steps.length - 1], list.filter((p) => p[fld] === steps[steps.length - 1]).length, "Done", "sx-green")}</div>
			<div class="sx-kb">${steps.slice(1).map((s, i) => { const arr = list.filter((p) => p[fld] === s); const idx = i + 1; return `<div class="sx-kc"><div class="sx-kh">${s}<span class="sx-kn">${arr.length}</span></div>${arr.map((p) => `<div class="sx-kcard ${p[odKey] ? "od" : ""}"><div class="sx-sh" style="margin-bottom:6px"><span class="sx-bd ${p[odKey] ? "r" : "t"}">Day ${p[dKey]}${p[sKey] ? ` / ${p[sKey]}` : ""}</span><span class="sx-mini">${p.system_kw || "?"} kW</span></div><b>${this.esc(p.customer_name)}</b><div class="sx-mini">${p.name}${track === "kseb" ? ` · ${this.esc(p.kseb_consumer_no || "")} · ${this.esc(p.kseb_section || "")}` : ` · ${this.money(p.subsidy_amount)}`}</div><div class="sx-row" style="margin-top:8px"><button class="sx-btn s" onclick="SX.open('${p.name}')">Open</button>${idx > 1 ? `<button class="sx-btn s" onclick="SX.boardMove('${p.name}','${track}','back')">←</button>` : ""}${idx < steps.length - 1 ? `<button class="sx-btn s p" onclick="SX.boardMove('${p.name}','${track}','forward')">→</button>` : ""}</div></div>`).join("") || `<div class="sx-mini">Empty</div>`}</div>`; }).join("")}</div>`;
	}
	kseb() { return this.head("KSEB Net-Metering", __("Each step runs on its own SLA clock. Moving back asks for a reason and is logged.")) + this.board("kseb"); }
	subsidy() { return this.head("PM Surya Ghar Subsidy", __("Runs in parallel with KSEB; does not block installation.")) + this.board("subsidy"); }

	/* ------------------------------------------------ quick quote */
	quote() {
		const S = this.B.settings;
		if (!this.q.price) this.q.price = S.default_price_per_kw || 60000;
		return this.head("Quick Quote", __("A 60-second estimate. Save it as a lead to start the real flow.")) +
			`<div class="sx-split"><div class="sx-card"><div class="sx-fg">
			<div class="sx-f"><label>Monthly KSEB bill</label><input type="number" value="${this.q.bill}" oninput="SX.q.bill=+this.value;SX.calc()"></div>
			<div class="sx-f"><label>Monthly units (optional)</label><input type="number" value="${this.q.units || ""}" oninput="SX.q.units=+this.value;SX.calc()"></div>
			<div class="sx-f"><label>Or system size (kW)</label><input type="number" value="${this.q.kw || ""}" oninput="SX.q.kw=+this.value;SX.calc()"></div>
			<div class="sx-f"><label>Price per kW</label><input type="number" value="${this.q.price}" oninput="SX.q.price=+this.value;SX.calc()"></div></div>
			<p class="sx-mini" style="margin-top:12px">Assumes 1 kW ≈ 120 units/month and ₹7.50/unit.</p></div>
			<div class="sx-card" id="sx-qres"></div></div>`;
	}
	calc() {
		const q = this.q;
		const kw = q.kw > 0 ? q.kw : q.units > 0 ? Math.ceil(q.units / 120) : Math.max(1, Math.ceil(q.bill / 7.5 / 120));
		const total = kw * q.price, sub = Math.min(78000, Math.min(kw, 2) * 30000 + Math.max(0, Math.min(kw - 2, 1)) * 18000);
		const save = kw * 120 * 12 * 7.5;
		this._qkw = kw;
		this.$w.find("#sx-qres").html(`<div class="sx-eb">Estimated net cost</div><div class="sx-qt">${this.money(total - sub)}</div>
			<div class="sx-ql"><span>System size</span><b>${kw} kW</b></div><div class="sx-ql"><span>System price (before tax)</span><b>${this.money(total)}</b></div>
			<div class="sx-ql"><span>PM Surya Ghar subsidy</span><b class="sx-green">− ${this.money(sub)}</b></div><div class="sx-ql"><span>Yearly savings</span><b>${this.money(save)}</b></div>
			<div class="sx-ql"><span>Payback</span><b>${((total - sub) / Math.max(1, save)).toFixed(1)} years</b></div>
			<button class="sx-btn p b" style="margin-top:14px" onclick="SX.newLead({monthly_bill:SX.q.bill,system_kw:SX._qkw})">Save as new lead →</button>`);
	}

	/* ------------------------------------------------ payments */
	accounts() {
		const rows = this.live().filter((p) => Object.keys(p.milestones || {}).length);
		const due = rows.reduce((s, p) => s + Object.values(p.milestones).reduce((a, m) => a + (m.docstatus === 1 ? m.outstanding : 0), 0), 0);
		const drafts = rows.reduce((s, p) => s + Object.values(p.milestones).filter((m) => m.docstatus === 0).length, 0);
		const cell = (p, k) => {
			const m = (p.milestones || {})[k];
			if (!m) return `<span class="sx-bd">—</span>`;
			const st = m.docstatus === 0 ? `<span class="sx-bd a">Draft</span>` : m.docstatus === 2 ? `<span class="sx-bd">Cancelled</span>` : m.paid ? `<span class="sx-bd g">Paid</span>` : `<span class="sx-bd r">${this.money(m.outstanding)}</span>`;
			return `${st} ${this.link("Sales Invoice", m.invoice)}${!m.paid && m.docstatus !== 2 ? ` <button class="sx-btn s" onclick="SX.pay('${p.name}','${k}')">Pay</button>` : ""}`;
		};
		return this.head("Payments", __("Milestone invoices are real ERPNext Sales Invoices; payments create Payment Entries.")) +
			`<div class="sx-grid sx-kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">${this.kpi("Outstanding (submitted)", this.money(due), "Customers owe", "sx-red")}${this.kpi("Draft invoices", drafts, "Not yet submitted")}${this.kpi("Projects billed", rows.length, "With at least one invoice")}</div>
			<div class="sx-tw"><table><thead><tr><th>Customer</th><th>Value</th><th>Advance</th><th>Installation</th><th>Final</th></tr></thead><tbody>
			${rows.map((p) => `<tr><td><a class="sx-link" onclick="SX.open('${p.name}')">${this.esc(p.customer_name)}</a><div class="sx-mini">${p.name}</div></td><td>${this.money(p.project_value)}</td><td>${cell(p, "advance")}</td><td>${cell(p, "installation")}</td><td>${cell(p, "final")}</td></tr>`).join("") || `<tr><td colspan="5" class="sx-empty">No invoices yet.</td></tr>`}</tbody></table></div>`;
	}

	/* ------------------------------------------------ workflow */
	workflow() {
		const c = (s) => this.live().filter((p) => p.stage === s).length;
		const box = (s, d) => `<div class="sx-fb" onclick="SX.filters.stage='${s}';SX.go('projects')"><b style="float:right" class="sx-bd t">${c(s)}</b><div class="sx-eb">${SX_ROLE_OF[s]}</div><h3 style="margin-top:4px">${this.label(s)}</h3><p class="sx-mini">${d}</p></div>`;
		const a = `<div class="sx-arrow">↓</div>`;
		return this.head("Workflow", __("What each stage creates in ERPNext.")) + `<div class="sx-card"><div class="sx-flow">
			${box("Lead", "Creates ERPNext Lead · duplicate check on mobile")}${a}${box("Site Visit", "ToDo assigned to surveyor · min 2 photos")}${a}
			${box("Quotation", "Creates Customer + draft Quotation")}${a}
			<div class="sx-fbr">${box("Loan", "Optional · disbursed → paper work")}<div class="sx-fb" style="background:#F5F7F4"><h3>No loan</h3><p class="sx-mini">Skips straight to paper work</p></div></div>${a}
			<div class="sx-mini">On acceptance: Quotation submitted · Sales Order submitted · advance Sales Invoice (draft)</div>${a}
			${box("Paper Work", "5 customer documents")}${a}${box("Approvals", "KSEB + PM Surya Ghar in parallel · 🔒 install needs feasibility + paid advance")}${a}
			${box("Installation", "Checklist · creates installation invoice")}${a}${box("Commissioning", "🔒 KSEB synchronised · signature · final invoice")}${a}${box("AMC", "Service every 6 months")}
			</div></div>`;
	}

	/* ------------------------------------------------ setup */
	setup() {
		return this.head("Setup Check", __("What must be configured in ERPNext before Solar X can work. Each ✗ is an error you would otherwise hit mid-flow."),
			`<a class="sx-btn p" target="_blank" href="/app/solar-x-settings">Open Solar X Settings</a>`) + `<div class="sx-card" id="sx-setup"><div class="sx-empty">Checking…</div></div>`;
	}
	async loadSetup() {
		let rows = [];
		try { rows = await this.call("setup_check", {}, false); } catch (e) { return; }
		this.$w.find("#sx-setup").html(rows.map((r) => `<div class="sx-ms"><div><b>${r.ok ? "✅" : "❌"} ${this.esc(r.label)}</b>${r.fix ? `<div class="sx-mini">${this.esc(r.fix)}</div>` : ""}</div></div>`).join(""));
	}
}
