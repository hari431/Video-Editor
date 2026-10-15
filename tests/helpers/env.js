process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/gosu_query_library_test';
process.env.NODE_ENV = 'test';
process.env.PREMIUM_ACCESS_DAYS = '15';
delete process.env.EMAIL_HOST;
delete process.env.EMAIL_FROM;
