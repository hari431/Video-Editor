import Razorpay from 'razorpay';
import fs from 'fs';

const rzp = new Razorpay({
  key_id: 'rzp_test_TYlYU49IteR6Z3',
  key_secret: '31akP9Ql75qX9g2Gd2DNWxgF'
});

async function run() {
  try {
    const plans = await rzp.plans.all();
    if (!plans.items || plans.items.length === 0) {
      console.log("No plans found");
      return;
    }
    const planId = plans.items[0].id;
    console.log("Using Plan ID:", planId);

    const sub = await rzp.subscriptions.create({
      plan_id: planId,
      total_count: 12,
      customer_notify: 0
    });
    
    console.log("--- FRESH CREATED SUB ---");
    console.log(JSON.stringify(sub, null, 2));

    const fetched = await rzp.subscriptions.fetch(sub.id);
    console.log("--- FETCHED SUB IMMEDIATELY ---");
    console.log(JSON.stringify(fetched, null, 2));

  } catch(e) { console.error(e); }
}

run();
