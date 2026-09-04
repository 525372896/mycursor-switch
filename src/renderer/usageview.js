'use strict';
// 额度页：内嵌 webview 用该账号登录态打开官网 Usage / Spending 两页；顶部两个按钮切换；
// 注入脚本把 Cursor 左侧导航（含左下角账号信息）整块隐藏，客户只看得到这两页内容。

var params = new URLSearchParams(location.search);
var part = params.get('part') || '';
var email = params.get('email') || '';
document.getElementById('email').textContent = email;

var USAGE = 'https://cursor.com/dashboard/usage';
var SPENDING = 'https://cursor.com/dashboard/spending';

var wv = document.createElement('webview');
if (part) wv.setAttribute('partition', part);   // 用 main 里注入了该号 cookie 的分区
wv.setAttribute('src', USAGE);
wv.setAttribute('allowpopups', 'false');
document.getElementById('wvwrap').appendChild(wv);

// 在页面里执行：把 Cursor 左侧导航整块隐藏，并让右侧内容占满整宽（左侧不留空白）。
// 定位用「多个当前菜单项文字」做锚点(旧版只认 "Back to Agents"，官网改版后失效)，再加「又高又窄又贴左」的几何兜底；
// 隐藏后折叠父级 grid 轨道 / 让同级内容 flex 撑满，消除左侧空白列。SPA 会重渲染，故持续重试 + MutationObserver 兜底。
var HIDE = `(function(){
  var ANCHORS=['Back to Agents','Billing & Invoices','Shared Canvases','API & SSH Keys','Cloud Agents','Integrations','Overview'];
  function byAnchor(){
    var all=document.body.querySelectorAll('a,span,div,button,p');
    for(var i=0;i<all.length;i++){
      var el=all[i]; if(el.children.length) continue;
      var t=(el.textContent||'').trim(); if(ANCHORS.indexOf(t)<0) continue;
      var n=el;
      for(var k=0;k<16&&n&&n!==document.body;k++){
        var r=n.getBoundingClientRect();
        if(r.height>window.innerHeight*0.5&&r.width>0&&r.width<520&&r.left<120) return n;
        n=n.parentElement;
      }
    }
    return null;
  }
  function byGeometry(){
    var cands=document.querySelectorAll('aside,nav,[role="navigation"],div');
    var best=null,bs=-1;
    for(var i=0;i<cands.length;i++){
      var el=cands[i],r=el.getBoundingClientRect();
      if(r.height<window.innerHeight*0.6) continue;
      if(r.width<=0||r.width>460) continue;
      if(r.left>100) continue;
      var links=el.querySelectorAll('a').length; if(links<3) continue;
      var sc=links+r.height/window.innerHeight*4-r.left*0.05;
      if(sc>bs){bs=sc;best=el;}
    }
    return best;
  }
  function killGap(el){
    el.style.setProperty('display','none','important');
    el.style.setProperty('width','0','important');
    el.style.setProperty('min-width','0','important');
    el.style.setProperty('max-width','0','important');
    var par=el.parentElement;
    if(par){
      for(var s=0;s<par.children.length;s++){
        var ch=par.children[s]; if(ch===el) continue;
        ch.style.setProperty('flex','1 1 auto','important');
        ch.style.setProperty('width','100%','important');
        ch.style.setProperty('max-width','none','important');
        ch.style.setProperty('margin-left','0','important');
      }
    }
    // 一直折叠到根：grid 轨道收成 1fr，逐层清掉左侧留白（padding/margin-left）
    var p=el.parentElement;
    while(p&&p!==document.documentElement){
      var cs=getComputedStyle(p);
      if((cs.display||'').indexOf('grid')>=0){
        p.style.setProperty('grid-template-columns','1fr','important');
        p.style.setProperty('grid-template-areas','none','important');
        p.style.setProperty('gap','0','important');
      }
      p.style.setProperty('padding-left','0','important');
      p.style.setProperty('margin-left','0','important');
      p=p.parentElement;
    }
  }
  // 兜底：直接定位右侧主内容（靠它里面稳定出现的文字），把它拉到最左、占满整宽——
  // 解决“侧栏虽已隐藏，但主内容仍被 grid 轨道 / 居中 max-width / 左 margin 推向右边”留下的空白。
  var MAIN=['Export CSV','Your Usage','Cumulative Tokens','Total tokens','On-demand','Usage per day','Group By'];
  function fillMain(){
    var all=document.body.querySelectorAll('h1,h2,h3,span,button,div,p'),leaf=null;
    for(var i=0;i<all.length;i++){ if(all[i].children.length) continue; var t=(all[i].textContent||'').trim(); if(MAIN.indexOf(t)>=0){ leaf=all[i]; break; } }
    if(!leaf) return;
    var n=leaf,box=null;
    for(var k=0;k<18&&n&&n!==document.body;k++){ var r=n.getBoundingClientRect(); if(r.width>window.innerWidth*0.5){ box=n; } n=n.parentElement; }
    if(!box) return;
    var q=box;
    while(q&&q!==document.documentElement){
      q.style.setProperty('margin-left','0','important');
      q.style.setProperty('max-width','none','important');
      var cs=getComputedStyle(q);
      if((cs.display||'').indexOf('grid')>=0){ q.style.setProperty('grid-template-columns','1fr','important'); q.style.setProperty('grid-template-areas','none','important'); }
      q=q.parentElement;
    }
    box.style.setProperty('width','100%','important');
    // 终极兜底：以上都清理过后仍明显偏右(left>40)，直接把主内容“钉死铺满”整个 webview 视口，彻底消灭空白
    if(box.getBoundingClientRect().left>40){
      box.style.setProperty('position','fixed','important');
      box.style.setProperty('left','0','important');
      box.style.setProperty('top','0','important');
      box.style.setProperty('right','0','important');
      box.style.setProperty('bottom','0','important');
      box.style.setProperty('width','100vw','important');
      box.style.setProperty('height','100vh','important');
      box.style.setProperty('max-width','none','important');
      box.style.setProperty('margin','0','important');
      box.style.setProperty('overflow','auto','important');
      box.style.setProperty('z-index','2147483646','important');
      box.style.setProperty('background','#fff','important');
    }
  }
  // 全覆盖兜底：浅层(<=6 层)扫描，凡是「左外边距/左内边距 >=120px」(给侧栏让位的那种)一律清零，
  // grid 一律折叠成单列。这样不管留白来自 grid 轨道、还是 margin-left、还是居中，都能消掉。
  function clearBigLeft(){
    var queue=[[document.body,0]];
    while(queue.length){
      var it=queue.shift(), el=it[0], dep=it[1];
      if(dep>0){
        var cs=getComputedStyle(el);
        if((parseFloat(cs.marginLeft)||0)>=120) el.style.setProperty('margin-left','0','important');
        if((parseFloat(cs.paddingLeft)||0)>=120) el.style.setProperty('padding-left','0','important');
        if((cs.display||'').indexOf('grid')>=0){ el.style.setProperty('grid-template-columns','1fr','important'); el.style.setProperty('grid-template-areas','none','important'); }
      }
      if(dep<6){ for(var i=0;i<el.children.length;i++) queue.push([el.children[i],dep+1]); }
    }
  }
  function setWide(){
    try{ document.documentElement.style.setProperty('overflow-x','hidden','important'); }catch(e){}
    var bs=[document.documentElement,document.body];
    for(var i=0;i<bs.length;i++){ var b=bs[i]; if(!b) continue; b.style.setProperty('margin-left','0','important'); b.style.setProperty('padding-left','0','important'); }
  }
  function h(){ try{ var sb=byAnchor()||byGeometry(); if(sb) killGap(sb); clearBigLeft(); fillMain(); setWide(); if(sb){ try{ console.log('__SB_DONE__'); }catch(e){} } return true; }catch(e){ return false; } }
  h();
  var c=0,iv=setInterval(function(){ c++; h(); if(c>60) clearInterval(iv); },500);
  try{
    var to=null;
    var mo=new MutationObserver(function(){ if(to) return; to=setTimeout(function(){ to=null; h(); },200); });
    mo.observe(document.body,{childList:true,subtree:true});
    setTimeout(function(){ try{ mo.disconnect(); }catch(e){} },45000);
  }catch(e){}
})();`;

function inject() { try { wv.executeJavaScript(HIDE); } catch (e) { /* ignore */ } }
wv.addEventListener('dom-ready', inject);
wv.addEventListener('did-navigate', inject);
wv.addEventListener('did-navigate-in-page', inject);

// 加载遮罩：整页导航(切 Usage/Spending)时先盖白遮罩，等注入脚本把侧栏藏好(收到 __SB_DONE__ 信号)再揭开，
// 这样就不会看到 Cursor 旧菜单一闪而过。收不到信号时用 did-stop-loading 兜底揭开。
var mask = document.getElementById('mask');
// 关键：Electron 的 <webview> 是独立进程、永远浮在普通 DOM 之上，DOM 遮罩盖不住它；
// 所以加载时必须把 webview 本身透明掉(opacity:0)，等侧栏藏好(收到 __SB_DONE__)再显现，才不会闪出旧菜单。
function showMask() { if (mask) mask.classList.remove('hide'); try { wv.style.setProperty('opacity', '0'); } catch (e) { /* ignore */ } }
function hideMask() { if (mask) mask.classList.add('hide'); try { wv.style.setProperty('opacity', '1'); } catch (e) { /* ignore */ } }
showMask(); // 初始就先藏住，等第一次隐藏侧栏完成再显现
wv.addEventListener('did-start-loading', showMask);
wv.addEventListener('did-stop-loading', function () { setTimeout(hideMask, 1800); });
wv.addEventListener('console-message', function (e) { if ((e.message || '').indexOf('__SB_DONE__') >= 0) hideMask(); });

var tabU = document.getElementById('tabUsage');
var tabS = document.getElementById('tabSpending');
function go(url, on) {
  showMask();
  try { wv.loadURL(url); } catch (e) { /* ignore */ }
  tabU.classList.toggle('on', on === 'u');
  tabS.classList.toggle('on', on === 's');
}
tabU.onclick = function () { go(USAGE, 'u'); };
tabS.onclick = function () { go(SPENDING, 's'); };
document.getElementById('reload').onclick = function () { try { wv.reload(); } catch (e) { /* ignore */ } };
