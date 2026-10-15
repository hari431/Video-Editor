const fs = require('fs');

let serverFile = fs.readFileSync('src/server.js', 'utf8');

const oldAdminLogic = `    await adminDeleteDiscussion(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      return res.redirect(buildThreadRedirect(id, 'deleted'));
    }`;

const newAdminLogic = `    const discussion = await getDiscussion(id);
    await adminDeleteDiscussion(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      if (discussion && discussion.item_path) {
         return res.redirect(contentRouteForPath(discussion.item_path) + discussion.item_path.split('/').map(encodeURIComponent).join('/') + '?msg=' + encodeURIComponent('Deleted.'));
      }
      return res.redirect(buildThreadRedirect(id, 'deleted'));
    }`;

if (serverFile.includes(oldAdminLogic)) {
    serverFile = serverFile.replace(oldAdminLogic, newAdminLogic);
    fs.writeFileSync('src/server.js', serverFile);
    console.log('Fixed admin discussions delete route');
} else {
    console.error('Could not find old admin logic');
}
