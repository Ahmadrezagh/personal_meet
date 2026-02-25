(function () {
  'use strict';

  var API = window.location.origin;

  function byId(id) { return document.getElementById(id); }
  function hint(msg, isError) {
    var el = byId('joinHint');
    el.textContent = msg;
    el.className = 'hint' + (isError ? ' error' : ' success');
  }

  function randomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var code = '';
    for (var i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
  }

  function createMeeting() {
    var name = (byId('yourName').value || '').trim() || 'Host';
    var code = randomCode();
    window.location.href = 'meet.html?code=' + encodeURIComponent(code) + '&name=' + encodeURIComponent(name) + '&host=1';
  }

  function joinMeeting() {
    var code = (byId('meetingCode').value || '').trim().toUpperCase();
    var name = (byId('yourNameJoin').value || '').trim() || 'Guest';
    if (!code) {
      hint('Enter a meeting code', true);
      return;
    }
    if (code.length < 4) {
      hint('Code too short', true);
      return;
    }
    window.location.href = 'meet.html?code=' + encodeURIComponent(code) + '&name=' + encodeURIComponent(name);
  }

  byId('btnCreate').addEventListener('click', createMeeting);
  byId('btnJoin').addEventListener('click', joinMeeting);
  byId('meetingCode').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') joinMeeting();
  });
})();
