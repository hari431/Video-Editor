import { pool } from './src/db/pool.js';
import express from 'express';

export function addDiagRoute(app) {
  app.get('/diag/db', async (req, res) => {
    try {
      const q1 = await pool.query('SELECT * FROM paid_products');
      const q2 = await pool.query('SELECT * FROM paid_product_plans');
      const q3 = await pool.query('SELECT * FROM user_product_grants ORDER BY id DESC LIMIT 5');
      const q4 = await pool.query('SELECT * FROM folder_roles');
      const q5 = await pool.query('SELECT * FROM roles');
      const q6 = await pool.query('SELECT * FROM users WHERE email = $1', ['b.harichandana.2023@gmail.com']);
      const q7 = await pool.query('SELECT * FROM user_roles WHERE user_id = $1', [q6.rows[0]?.id]);
      res.json({
        products: q1.rows,
        plans: q2.rows,
        grants: q3.rows,
        folderRoles: q4.rows,
        roles: q5.rows,
        user: q6.rows,
        userRoles: q7.rows
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });
}
