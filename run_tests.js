const { execSync } = require('child_process');
try {
  const output = execSync('npm test', { cwd: 'D:\\gosu-query-library-starter' }).toString();
  const passes = (output.match(/✔/g) || []).length;
  const fails = (output.match(/✖/g) || []).length;
  console.log('Passes:', passes, 'Fails:', fails);
} catch(e) {
  console.error(e.message);
}