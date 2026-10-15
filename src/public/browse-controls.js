(function(){
  // Shared browse controls helper — reused by My Liked Items, My Notes, Library, Knowledge
  // Minimal, client-side only, localStorage-backed, deterministic sorting
  window.BrowseControls = window.BrowseControls || {};
  window.BrowseControls.setup = function(opts){
    var container = document.getElementById(opts.containerId);
    var grid = document.getElementById(opts.gridId);
    var detailsBody = opts.detailsBodyId ? document.getElementById(opts.detailsBodyId) : null;
    var sortSel = document.getElementById(opts.sortSelectId);
    var viewSel = document.getElementById(opts.viewSelectId);
    if (!container || !grid || !sortSel || !viewSel) return;
    var lsSort = opts.lsSortKey;
    var lsView = opts.lsViewKey;
    var sortFns = opts.sortFns || {};
    var defaultSort = opts.defaultSort || sortSel.value;
    var defaultView = opts.defaultView || viewSel.value;
    var groupFoldersFirst = !!opts.groupFoldersFirst;
    function isFolderEl(el){
      return el.getAttribute('data-is-folder') === '1' || el.getAttribute('data-type') === 'folder';
    }
    // Preserve original order for "relevance" sorts that return null
    var originalCards = Array.from(grid.children);
    var originalRows = detailsBody ? Array.from(detailsBody.children) : [];
    function getSortFn(val){
      if (sortFns.hasOwnProperty(val)) return sortFns[val];
      if (sortFns.hasOwnProperty(defaultSort)) return sortFns[defaultSort];
      return null;
    }
    function applySort(val){
      var fn = getSortFn(val);
      if (!fn) {
        // relevance: restore original order
        if (groupFoldersFirst){
          var foldersOrig = originalCards.filter(isFolderEl);
          var filesOrig = originalCards.filter(function(el){ return !isFolderEl(el); });
          foldersOrig.forEach(function(el){ grid.appendChild(el); });
          filesOrig.forEach(function(el){ grid.appendChild(el); });
          if (detailsBody){
            var rowsFO = originalRows.filter(isFolderEl);
            var rowsFI = originalRows.filter(function(el){ return !isFolderEl(el); });
            rowsFO.forEach(function(el){ detailsBody.appendChild(el); });
            rowsFI.forEach(function(el){ detailsBody.appendChild(el); });
          }
        } else {
          originalCards.forEach(function(el){ grid.appendChild(el); });
          if (detailsBody) originalRows.forEach(function(el){ detailsBody.appendChild(el); });
        }
        return;
      }
      if (groupFoldersFirst){
        var allCards = Array.from(grid.children);
        var folders = allCards.filter(isFolderEl);
        var files = allCards.filter(function(el){ return !isFolderEl(el); });
        folders.sort(fn);
        files.sort(fn);
        folders.concat(files).forEach(function(el){ grid.appendChild(el); });
        if (detailsBody) {
          var allRows = Array.from(detailsBody.children);
          var rowsFolders = allRows.filter(isFolderEl);
          var rowsFiles = allRows.filter(function(el){ return !isFolderEl(el); });
          rowsFolders.sort(fn);
          rowsFiles.sort(fn);
          rowsFolders.concat(rowsFiles).forEach(function(el){ detailsBody.appendChild(el); });
        }
      } else {
        var cards = Array.from(grid.children);
        cards.sort(fn);
        cards.forEach(function(el){ grid.appendChild(el); });
        if (detailsBody) {
          var rows = Array.from(detailsBody.children);
          rows.sort(fn);
          rows.forEach(function(el){ detailsBody.appendChild(el); });
        }
      }
    }
    function applyView(val){
      container.classList.remove('view-mode-cards','view-mode-list','view-mode-details');
      if (val === 'list') container.classList.add('view-mode-list');
      else if (val === 'details') container.classList.add('view-mode-details');
      else container.classList.add('view-mode-cards');
    }
    var savedSort = localStorage.getItem(lsSort);
    var savedView = localStorage.getItem(lsView);
    if (savedSort && sortSel.querySelector('option[value="'+savedSort+'"]')) sortSel.value = savedSort;
    else if (sortFns.hasOwnProperty(defaultSort)) sortSel.value = defaultSort;
    if (savedView && viewSel.querySelector('option[value="'+savedView+'"]')) viewSel.value = savedView;
    else if (defaultView) viewSel.value = defaultView;
    // Only auto-apply if not relevance default (search keeps relevance)
    if (sortSel.value !== 'relevance') applySort(sortSel.value);
    applyView(viewSel.value);
    sortSel.addEventListener('change', function(){ localStorage.setItem(lsSort, sortSel.value); applySort(sortSel.value); });
    viewSel.addEventListener('change', function(){ localStorage.setItem(lsView, viewSel.value); applyView(viewSel.value); });
  };
})();
