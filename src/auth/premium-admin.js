import { pool } from '../db/pool.js';
import { getPromoCodes } from './premium.js';

export async function getPremiumDashboardData(filter, search) {
  const data = {
    kpis: {
      activePremium: 0,
      recurringMembers: 0,
      oneTimePasses: 0,
      promoRedemptions: 0,
      expiringSoon: 0,
      newPremiumThisMonth: 0,
      totalRevenue: null, // Unsupported fully by schema
      thisMonthRevenue: null,
      manualMembers: 0
    },
    needsAttention: [],
    members: [],
    promotions: []
  };

  // 1. KPIs
  const kpiQuery = `
    SELECT 
      COUNT(*) FILTER (WHERE app_role = 'PREMIUM') as active_premium,
      COUNT(*) FILTER (WHERE app_role = 'PREMIUM' AND premium_source = 'subscription') as recurring_members,
      COUNT(*) FILTER (WHERE app_role = 'PREMIUM' AND premium_source = 'one_time') as one_time_passes,
      COUNT(*) FILTER (WHERE app_role = 'PREMIUM' AND premium_source = 'manual') as manual_members
    FROM users
  `;
  const kpiResult = await pool.query(kpiQuery);
  const kpiRow = kpiResult.rows[0];
  data.kpis.activePremium = parseInt(kpiRow.active_premium, 10);
  data.kpis.recurringMembers = parseInt(kpiRow.recurring_members, 10);
  data.kpis.oneTimePasses = parseInt(kpiRow.one_time_passes, 10);
  data.kpis.manualMembers = parseInt(kpiRow.manual_members, 10);

  const promoRedemptions = await pool.query('SELECT COUNT(*) FROM premium_promo_redemptions');
  data.kpis.promoRedemptions = parseInt(promoRedemptions.rows[0].count, 10);

  const expiringQuery = `
    SELECT COUNT(*) 
    FROM users u
    LEFT JOIN premium_subscriptions ps ON ps.user_id = u.id AND ps.status = 'active'
    WHERE u.app_role = 'PREMIUM' AND (
      (u.premium_source = 'one_time' AND u.access_expires_at IS NOT NULL AND u.access_expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days')
      OR
      (u.premium_source = 'subscription' AND ps.cancel_at_period_end = TRUE AND ps.current_period_end BETWEEN NOW() AND NOW() + INTERVAL '7 days')
    )
  `;
  const expiringResult = await pool.query(expiringQuery);
  data.kpis.expiringSoon = parseInt(expiringResult.rows[0].count, 10);

  const newThisMonthQuery = `
    SELECT COUNT(DISTINCT user_id) 
    FROM premium_subscription_events 
    WHERE created_at >= date_trunc('month', NOW()) 
      AND (new_status = 'active' OR event_type = 'one_time_purchase')
  `;
  const newThisMonthResult = await pool.query(newThisMonthQuery);
  data.kpis.newPremiumThisMonth = parseInt(newThisMonthResult.rows[0].count, 10);

  // 2. Members Query
  let memberQuery = `
    SELECT 
      u.id, u.name, u.email, u.app_role, u.premium_source, u.access_expires_at,
      ps.status as sub_status, ps.current_period_start, ps.current_period_end, ps.cancel_at_period_end, ps.plan_id,
      pr.promotion_code, pr.final_amount_paise,
      pse.message as one_time_message, pse.created_at as one_time_date
    FROM users u
    LEFT JOIN premium_subscriptions ps ON ps.user_id = u.id AND ps.status IN ('active', 'authenticated', 'cancelled', 'expired')
    LEFT JOIN premium_promo_redemptions pr ON pr.user_id = u.id
    LEFT JOIN premium_subscription_events pse ON pse.user_id = u.id AND pse.event_type = 'one_time_purchase'
    WHERE (u.app_role = 'PREMIUM' OR ps.id IS NOT NULL OR pr.id IS NOT NULL OR pse.id IS NOT NULL)
  `;
  
  const params = [];
  
  if (filter === 'recurring') { memberQuery += ` AND u.premium_source = 'subscription'`; }
  else if (filter === 'one_time') { memberQuery += ` AND u.premium_source = 'one_time'`; }
  else if (filter === 'manual') { memberQuery += ` AND u.premium_source = 'manual'`; }
  else if (filter === 'active') { memberQuery += ` AND u.app_role = 'PREMIUM'`; }
  else if (filter === 'expired') { memberQuery += ` AND u.app_role != 'PREMIUM' AND (ps.id IS NOT NULL OR pse.id IS NOT NULL)`; }
  else if (filter === 'expiring_soon') {
    memberQuery += ` AND u.app_role = 'PREMIUM' AND (
      (u.premium_source = 'one_time' AND u.access_expires_at IS NOT NULL AND u.access_expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days')
      OR
      (u.premium_source = 'subscription' AND ps.cancel_at_period_end = TRUE AND ps.current_period_end BETWEEN NOW() AND NOW() + INTERVAL '7 days')
    )`;
  }
  else if (filter === 'promo_used') { memberQuery += ` AND pr.id IS NOT NULL`; }
  else if (filter === 'no_promo') { memberQuery += ` AND pr.id IS NULL AND u.premium_source != 'manual'`; }
  
  if (search) {
    memberQuery += ` AND (u.name ILIKE $1 OR u.email ILIKE $1)`;
    params.push(`%${search}%`);
  }
  
  memberQuery += ` ORDER BY u.id DESC`; // Simplified order

  const membersResult = await pool.query(memberQuery, params);
  
  // Deduplicate users because LEFT JOINs might produce multiple rows per user (especially if they have multiple events/promos)
  const uniqueMembersMap = new Map();
  membersResult.rows.forEach(row => {
    if (!uniqueMembersMap.has(row.id)) {
      uniqueMembersMap.set(row.id, row);
    } else {
      // Pick the most relevant info (e.g., active subscription over cancelled)
      const existing = uniqueMembersMap.get(row.id);
      if (row.sub_status === 'active' && existing.sub_status !== 'active') {
        uniqueMembersMap.set(row.id, row);
      }
    }
  });
  data.members = Array.from(uniqueMembersMap.values());

  // 3. Needs Attention
  // Recurring payment failures (e.g. past due or webhook events indicating failure)
  const paymentFailuresQuery = `
    SELECT u.name, u.email, pse.message, pse.created_at
    FROM premium_subscription_events pse
    JOIN users u ON u.id = pse.user_id
    WHERE pse.event_type LIKE '%failed%' OR pse.new_status = 'halted'
    ORDER BY pse.created_at DESC LIMIT 10
  `;
  const failures = await pool.query(paymentFailuresQuery);
  failures.rows.forEach(f => {
    data.needsAttention.push({
      type: 'payment_failure',
      message: `Payment failed for ${f.name || f.email}: ${f.message}`,
      date: f.created_at
    });
  });

  // Expiring soon is a KPI, but we can also add them to needs attention if we want, or just link to them.
  if (data.kpis.expiringSoon > 0) {
    data.needsAttention.push({
      type: 'expiring_soon',
      message: `${data.kpis.expiringSoon} Premium members have access expiring in the next 7 days.`,
      link: '/admin/premium?filter=expiring_soon'
    });
  }

  // 4. Promotions
  const configuredPromos = getPromoCodes();
  
  // Aggregate DB stats for promos
  const promoStatsQuery = `
    SELECT promotion_code, COUNT(*) as used_count
    FROM premium_promo_redemptions
    GROUP BY promotion_code
  `;
  const promoStatsResult = await pool.query(promoStatsQuery);
  const promoStatsMap = {};
  promoStatsResult.rows.forEach(r => {
    promoStatsMap[r.promotion_code.toUpperCase()] = parseInt(r.used_count, 10);
  });

  data.promotions = configuredPromos.map(p => {
    const used = promoStatsMap[p.code.toUpperCase()] || 0;
    const remaining = p.maxRedemptions ? Math.max(0, p.maxRedemptions - used) : null;
    
    let health = '🟢 Active';
    if (!p.enabled) {
      health = '⚪ Disabled';
    } else if (p.maxRedemptions && remaining === 0) {
      health = '🔴 Exhausted';
    } else if (p.maxRedemptions && remaining <= 5) {
      health = '🟠 Almost Full';
    }

    return {
      code: p.code,
      type: p.type,
      value: p.value,
      eligibilityDays: p.eligibilityDays,
      maxRedemptions: p.maxRedemptions,
      usedCount: used,
      remainingRedemptions: remaining,
      enabled: p.enabled,
      health
    };
  });
  
  // Check exhausted promos for needs attention
  data.promotions.forEach(p => {
    if (p.health === '🔴 Exhausted') {
      data.needsAttention.push({
        type: 'promo_exhausted',
        message: `Promotion campaign ${p.code} has reached its redemption limit.`,
      });
    }
  });

  // 5. Grouped Offerings
  try {
    const offeringsRes = await pool.query(`
      SELECT id, name, code, is_enabled 
      FROM paid_products 
      ORDER BY name ASC
    `);
    const offerings = offeringsRes.rows;

    const grantsRes = await pool.query(`
      SELECT 
        g.product_id,
        u.id AS user_id,
        u.name AS user_name,
        u.email AS user_email
      FROM user_product_grants g
      JOIN users u ON g.user_id = u.id
      WHERE g.status = 'active'
        AND (g.valid_until IS NULL OR g.valid_until > NOW())
    `);
    const activeGrants = grantsRes.rows;

    const legacyUsersRes = await pool.query(`
      SELECT id AS user_id, name AS user_name, email AS user_email
      FROM users
      WHERE app_role = 'PREMIUM'
    `);
    const legacyPremiumUsers = legacyUsersRes.rows;

    const productMembersMap = new Map();
    offerings.forEach(prod => {
      productMembersMap.set(prod.id, []);
    });

    activeGrants.forEach(grant => {
      const membersList = productMembersMap.get(grant.product_id);
      if (membersList) {
        if (!membersList.some(m => m.user_id === grant.user_id)) {
          membersList.push({
            user_id: grant.user_id,
            user_name: grant.user_name,
            user_email: grant.user_email
          });
        }
      }
    });

    const premiumProduct = offerings.find(p => p.code === 'PREMIUM');
    if (premiumProduct) {
      const premiumMembersList = productMembersMap.get(premiumProduct.id);
      if (premiumMembersList) {
        legacyPremiumUsers.forEach(lu => {
          if (!premiumMembersList.some(m => m.user_id === lu.user_id)) {
            premiumMembersList.push({
              user_id: lu.user_id,
              user_name: lu.user_name,
              user_email: lu.user_email
            });
          }
        });
      }
    }

    data.groupedOfferings = offerings.map(prod => {
      const members = productMembersMap.get(prod.id) || [];
      return {
        id: prod.id,
        name: prod.name,
        code: prod.code,
        totalCount: members.length,
        members: members.sort((a, b) => {
          const nameA = (a.user_name || '').toLowerCase();
          const nameB = (b.user_name || '').toLowerCase();
          if (nameA < nameB) return -1;
          if (nameA > nameB) return 1;
          return (a.user_email || '').toLowerCase().localeCompare((b.user_email || '').toLowerCase());
        })
      };
    });
  } catch (err) {
    console.error('Error fetching grouped offerings:', err);
    data.groupedOfferings = [];
  }

  return data;
}
