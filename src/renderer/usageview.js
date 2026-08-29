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

// 在页面里执行：定位含「Back to Agents」的侧边栏容器（高占大半视口、较窄、贴左）并隐藏——
// 这样左侧全部菜单 + 左下角账号信息一起没了。SPA 会重渲染，故持续重试 + MutationObserver 兜底。
var HIDE = "(function(){function h(){try{var leaf=null,all=document.body.querySelectorAll('a,span,div,button,p,h1,h2');for(var i=0;i<all.length;i++){if(all[i].children.length===0){var t=(all[i].textContent||'').trim();if(t==='Back to Agents'){leaf=all[i];break;}}}if(leaf){var n=leaf;for(var k=0;k<12&&n&&n.parentElement&&n.parentElement!==document.body;k++){var r=n.getBoundingClientRect();if(r.height>window.innerHeight*0.5&&r.width>0&&r.width<420&&r.left<80){n.style.setProperty('display','none','important');return true;}n=n.parentElement;}}}catch(e){}return false;}h();var c=0,iv=setInterval(function(){c++;h();if(c>40)clearInterval(iv);},500);try{var mo=new MutationObserver(function(){h();});mo.observe(document.body,{childList:true,subtree:true});setTimeout(function(){try{mo.disconnect();}catch(e){}},30000);}catch(e){}})();";

function inject() { try { wv.executeJavaScript(HIDE); } catch (e) { /* ignore */ } }
wv.addEventListener('dom-ready', inject);
wv.addEventListener('did-navigate', inject);
wv.addEventListener('did-navigate-in-page', inject);

var tabU = document.getElementById('tabUsage');
var tabS = document.getElementById('tabSpending');
function go(url, on) {
  try { wv.loadURL(url); } catch (e) { /* ignore */ }
  tabU.classList.toggle('on', on === 'u');
  tabS.classList.toggle('on', on === 's');
}
tabU.onclick = function () { go(USAGE, 'u'); };
tabS.onclick = function () { go(SPENDING, 's'); };
document.getElementById('reload').onclick = function () { try { wv.reload(); } catch (e) { /* ignore */ } };
