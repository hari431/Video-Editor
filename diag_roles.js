import { pool } from './src/db/pool.js';

async function run() {
  try {
    const userEmail = 'b.harichandana.2023@gmail.com';
    const userRes = await pool.query("SELECT id, email, app_role, access_expires_at FROM users WHERE email = $1", [userEmail]);
    const user = userRes.rows[0];
    if (!user) return console.log("User not found");
    
    console.log("User:", user);
    
    const prodRes = await pool.query("SELECT id, code, role_id FROM paid_products");
    console.log("Products:", prodRes.rows);

    const rolesRes = await pool.query("SELECT * FROM user_roles WHERE user_id = $1", [user.id]);
    console.log("User Roles:", rolesRes.rows);

    const folderRolesRes = await pool.query("SELECT folder_id, role_id FROM folder_roles");
    console.log("Folder Roles:", folderRolesRes.rows);

    const legacyFolders = await pool.query("SELECT id, name, requires_premium, premium_only FROM folders WHERE requires_premium = true OR premium_only = true");
    console.log("Legacy Premium Folders:", legacyFolders.rows);
  } finally {
    await pool.end();
  }
}
run();
