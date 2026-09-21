'use strict';
// Static board definitions: groups, statuses, labels, colours. These match the
// Monday boards (plus "Landed — Receiving", added at Liam's request). The live
// data itself is loaded into QB by db.js.
(function () {
  const iso = (d) => d.toISOString().slice(0, 10);
  const dd = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
  const firstOfMonth = (add) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + add); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
  const lab = (rows) => rows.map(([key, label, color]) => ({ key, label, color }));

  const GROUPS = [];
  [['po_forecast', '🔁 Monthly Forecast Cycle', '#579bfc'], ['po_drafting', '📝 Drafting Orders', '#a25ddc'],
    ['po_placed', '🏭 Placed — In Production', '#e8912d'], ['po_water', '🚢 On the Water', '#007eb5'],
    ['po_landed', '🛬 Landed & Receiving', '#00a35f'], ['po_done', '✅ Done', '#9aa0a8'],
  ].forEach(([key, label, color]) => GROUPS.push({ key, label, color, boards: ['pos'] }));
  [['rs_stretch', 'Stretch Wrap', '#579bfc'], ['rs_paper', 'Flat Paper Bags', '#e8912d'], ['rs_boxes', '📦 Boxes & Cartons', '#7f5347'],
    ['rs_reseal', '🔒 Resealable & Pouches', '#a25ddc'], ['rs_sealers', 'Heat Sealers', '#e2445c'], ['rs_poly', '🛍️ Poly & Plastic Bags', '#00a35f'],
  ].forEach(([key, label, color]) => GROUPS.push({ key, label, color, boards: ['research'] }));

  const STATUS = {
    pos: lab([   // the "Health" column
      ['drafting', 'Drafting', '#c4c4c4'], ['review', 'LN Review/JH Approval', '#007eb5'], ['waiting', 'Waiting on Supplier', '#fdab3d'],
      ['in_production', 'In Production', '#66ccff'], ['forwarder', 'Deciding Freight Forwarder', '#037f4c'], ['on_water', 'On Water', '#cab641'],
      ['landed', 'Landed — Receiving', '#00c875'],
      ['action', 'QIS Action Needed', '#ff6d3b'], ['blocked', 'Blocked', '#df2f4a'], ['done', 'Done', '#9d50dd'],
    ]),
    research: lab([   // the "Stage" column
      ['identified', 'Supplier Identified', '#c4c4c4'], ['spec_sent', 'Specification Sheet Sent', '#fdab3d'],
      ['push1', '1st Round of Price Pushbacks', '#df2f4a'], ['push2', '2nd Round of Price Pushbacks', '#9d50dd'],
      ['samples', 'Pending Samples', '#ffcb00'], ['negotiation', 'MOQ/Deposit/Price Negotiation', '#007eb5'],
      ['internal', 'Pending QIS Internal Action', '#ff007f'], ['approved', 'Approved — Ready to Use', '#00c875'], ['parked', 'Parked / No Go', '#333333'],
    ]),
  };
  const PRIORITY = lab([['critical', 'Critical', '#333333'], ['high', 'High', '#401694'], ['medium', 'Medium', '#5559df'], ['low', 'Low', '#579bfc']]);

  window.QB = {
    dd, firstOfMonth, GROUPS, STATUS, PRIORITY,
    FORWARDERS: ['Toll', 'DB Schenker', 'Cyclone', 'Blacks', 'Other'],
    CATEGORIES: ['Stretch Wrap', 'Flat Paper Bags', 'Boxes & Cartons', 'Resealable & Pouches', 'Heat Sealers', 'Poly & Plastic Bags'],
    TIERS: { Preferred: '#00c875', Approved: '#579bfc', Backup: '#fdab3d', Trial: '#a25ddc', 'Do not use': '#333333' },
    PEOPLE: [], AREA_PEOPLE: { purchasing: [] }, suppliers: [], items: [], updates: {}, activity: {},
  };
})();
