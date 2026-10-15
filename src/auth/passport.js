import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { pool } from '../db/pool.js';
import { isAdminEmail } from './admin.js';
import {
  findUserByGoogleId,
  createPendingUser,
  createAdminUser,
  touchExistingUser,
  normalizeAdminUser
} from './users.js';
import { getReqId } from '../utils/perf.js';

const perfDiagnosticsEnabled = String(process.env.PERF_DIAGNOSTICS || 'false').toLowerCase() === 'true';

export function configurePassport() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.warn('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    return;
  }

  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL}/auth/google/callback`,
    state: true
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email || !profile.id) {
        return done(new Error('Google account did not provide the required identity information.'));
      }

      // Google OAuth authenticates the account. Authorization is handled by the
      // users.status / access_expires_at fields and the authorization middleware.
      // Accounts configured in ADMIN_EMAILS are permanent administrators: they are
      // always active with no expiry, and login normalizes them to that state.
      const admin = isAdminEmail(email);
      let user;
      const existing = await findUserByGoogleId(profile.id);
      if (!existing) {
        if (admin) {
          user = await createAdminUser(profile);
        } else {
          // First login: create the user as 'pending' with NO access until an
          // administrator approves them. Never auto-grant access here.
          user = await createPendingUser(profile);
        }
      } else if (admin) {
        user = await normalizeAdminUser(existing.id, profile);
      } else {
        // Returning login: refresh only profile/login information.
        // status and access_expires_at are deliberately left untouched, so
        // logging in can never grant, extend, or reactivate access.
        user = await touchExistingUser(existing.id, profile);
      }
      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }));

  passport.serializeUser((user, done) => done(null, user.id));

  passport.deserializeUser(async (id, done) => {
    const tTotal = perfDiagnosticsEnabled ? Date.now() : 0;
    let tUserQuery = 0, tRolesQuery = 0, tGrantsQuery = 0;
    try {
      let t0 = perfDiagnosticsEnabled ? Date.now() : 0;
      const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
      if (perfDiagnosticsEnabled) tUserQuery = Date.now() - t0;
      const user = result.rows[0];
      if (!user) {
        if (perfDiagnosticsEnabled) {
          const total = Date.now() - tTotal;
          const reqId = getReqId();
          console.log(`PERF deserializeUser reqId=${reqId} total=${total}ms userQuery=${tUserQuery}ms rolesQuery=0ms grantsQuery=0ms miss=1`);
        }
        return done(null, false);
      }
      try {
        let rolesResult, grantsResult;
        if (perfDiagnosticsEnabled) {
          const tR = Date.now();
          const tG = Date.now();
          const rolesPromise = pool.query(
            'SELECT role_id, assignment_source FROM user_roles WHERE user_id = $1',
            [id]
          ).then(r => { tRolesQuery = Date.now() - tR; return r; }).catch(e => { tRolesQuery = Date.now() - tR; throw e; });
          const grantsPromise = pool.query(
            `SELECT g.id, g.product_id, g.valid_until, g.status, p.name as product_name, p.code as product_code, p.role_id 
           FROM user_product_grants g
           JOIN paid_products p ON g.product_id = p.id
           WHERE g.user_id = $1
             AND g.status = 'active'
             AND (g.valid_until IS NULL OR g.valid_until > NOW())
           ORDER BY g.valid_until DESC NULLS FIRST, g.created_at DESC`,
            [id]
          ).then(r => { tGrantsQuery = Date.now() - tG; return r; }).catch(e => { tGrantsQuery = Date.now() - tG; throw e; });
          [rolesResult, grantsResult] = await Promise.all([rolesPromise, grantsPromise]);
        } else {
          [rolesResult, grantsResult] = await Promise.all([
            pool.query('SELECT role_id, assignment_source FROM user_roles WHERE user_id = $1', [id]),
            pool.query(
              `SELECT g.id, g.product_id, g.valid_until, g.status, p.name as product_name, p.code as product_code, p.role_id 
           FROM user_product_grants g
           JOIN paid_products p ON g.product_id = p.id
           WHERE g.user_id = $1
             AND g.status = 'active'
             AND (g.valid_until IS NULL OR g.valid_until > NOW())
           ORDER BY g.valid_until DESC NULLS FIRST, g.created_at DESC`,
              [id]
            )
          ]);
        }
        user.roles = rolesResult.rows.map(r => Number(r.role_id));
        const paymentRoles = rolesResult.rows
          .filter(r => r.assignment_source === 'payment_system')
          .map(r => Number(r.role_id));
        const grantRoleIds = grantsResult.rows.map(r => Number(r.role_id));

        user.paidProductRoleIds = Array.from(new Set([...paymentRoles, ...grantRoleIds]));
        user.activeGrants = grantsResult.rows;
      } catch {
        user.roles = [];
        user.paidProductRoleIds = [];
        user.activeGrants = [];
      }
      if (perfDiagnosticsEnabled) {
        const total = Date.now() - tTotal;
        const reqId = getReqId();
        console.log(`PERF deserializeUser reqId=${reqId} total=${total}ms userQuery=${tUserQuery}ms rolesQuery=${tRolesQuery}ms grantsQuery=${tGrantsQuery}ms`);
      }
      done(null, user);
    } catch (error) {
      if (perfDiagnosticsEnabled) {
        const total = Date.now() - tTotal;
        const reqId = getReqId();
        console.log(`PERF deserializeUser reqId=${reqId} total=${total}ms error=1`);
      }
      done(error);
    }
  });
}

export { passport };