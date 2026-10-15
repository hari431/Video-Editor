import cookieSignature from 'cookie-signature';
const secret = 'test-only-secret';
const sid = 'delete-owner-sid';
console.log(`s:${cookieSignature.sign(sid, secret)}`);
