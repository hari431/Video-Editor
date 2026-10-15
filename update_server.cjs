const fs = require('fs');

let serverContent = fs.readFileSync('src/server.js', 'utf8');

// Replace the /account handler
const oldHandlerStart = "app.get('/account', requireAuth, async (req, res, next) => {";
const nextRouteStart = "\n// GET /plans";

const startIndex = serverContent.indexOf(oldHandlerStart);
const endIndex = serverContent.indexOf(nextRouteStart);

if (startIndex !== -1 && endIndex !== -1) {
  const newHandler = `app.get('/account', requireAuth, async (req, res, next) => {
  try {
    const { pool } = await import('./db/pool.js');
    
    // Fetch all generic grants (both active and expired) to keep duplicate purchase/grant history intact
    // but show each clearly without deleting historical records
    const grantsRes = await pool.query(
      \`SELECT g.id, g.valid_until, g.status, p.name as product_name, p.code as product_code,
              pl.name as plan_name, pl.billing_type
       FROM user_product_grants g
       JOIN paid_products p ON g.product_id = p.id
       LEFT JOIN paid_product_plans pl ON g.plan_id = pl.id
       WHERE g.user_id = $1 
       ORDER BY 
         CASE WHEN g.status = 'active' AND (g.valid_until IS NULL OR g.valid_until > NOW()) THEN 0 ELSE 1 END ASC,
         g.created_at DESC\`,
      [req.user.id]
    );
    let allProducts = grantsRes.rows;

    res.render("account", { user: req.user, allProducts });
  } catch (err) {
    next(err);
  }
});`;

  serverContent = serverContent.substring(0, startIndex) + newHandler + serverContent.substring(endIndex);
  fs.writeFileSync('src/server.js', serverContent);
  console.log('src/server.js updated');
} else {
  console.log('Failed to find /account handler boundaries');
}

// Update src/views/account.ejs
let accountContent = fs.readFileSync('src/views/account.ejs', 'utf8');
accountContent = accountContent.replace(/activeProducts/g, 'allProducts');
accountContent = accountContent.replace('Active Paid Products', 'Paid Products & Grants');
// Update the rendering logic to show inactive correctly
accountContent = accountContent.replace(
  /<span class="badge badge-healthy"[^>]*>ACTIVE<\/span>/,
  `<% const isActive = prod.status === 'active' && (!prod.valid_until || new Date(prod.valid_until) > new Date()); %>
            <% if (isActive) { %>
              <span class="badge badge-healthy" style="padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; background: #ecfdf5; color: #047857;">ACTIVE</span>
            <% } else { %>
              <span class="badge badge-expired" style="padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; background: #f1f5f9; color: #64748b;">EXPIRED</span>
            <% } %>`
);
fs.writeFileSync('src/views/account.ejs', accountContent);
console.log('src/views/account.ejs updated');

