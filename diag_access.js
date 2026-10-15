import { pool } from './src/db/pool.js';

async function run() {
  try {
    const userEmail = 'b.harichandana.2023@gmail.com';
    console.log(`--- User: ${userEmail} ---`);
    const userRes = await pool.query("SELECT id, email, app_role, premium_source, access_expires_at FROM users WHERE email = $1", [userEmail]);
    const user = userRes.rows[0];
    if (!user) {
      console.log("User not found");
      return;
    }
    console.log(user);

    console.log('\n--- Paid Products ---');
    const productsRes = await pool.query("SELECT id, code, name, role_id FROM paid_products");
    console.log(productsRes.rows);

    console.log('\n--- User Roles ---');
    const rolesRes = await pool.query("SELECT ur.*, r.name as role_name FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = $1", [user.id]);
    console.log(rolesRes.rows);

    console.log('\n--- Folder Role Access Mappings ---');
    const folderRes = await pool.query("SELECT id, name, requires_premium, premium_only FROM folders WHERE requires_premium = true OR premium_only = true LIMIT 5");
    console.log("Premium-only folders (legacy flags):", folderRes.rows);

    const folderRolesRes = await pool.query("SELECT fr.folder_id, f.name as folder_name, fr.role_id, r.name as role_name FROM folder_roles fr JOIN folders f ON fr.folder_id = f.id JOIN roles r ON fr.role_id = r.id");
    console.log("Folder-Role mappings:");
    console.log(folderRolesRes.rows.slice(0, 10));

    console.log('\n--- User Product Grants ---');
    const grantsRes = await pool.query("SELECT id, product_id, valid_from, valid_until, status FROM user_product_grants WHERE user_id = $1", [user.id]);
    console.log(grantsRes.rows);

  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}

run();
