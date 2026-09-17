/*
 * Arrow Switch — cutting presets.
 *
 * Built-in presets plus the user's own, saved as JSON through a tiny storage backend
 * ({ read() -> string|null, write(string) }) so the logic is testable and the panel can
 * keep presets in a file that survives reinstalls.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ArrowSwitchPresets = api;
  else root.ArrowSwitchPresets = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Everything a preset remembers.
  var KEYS = ['sensitivityDb', 'minTalkSec', 'minShotSec', 'maxShotSec', 'wideShotSec', 'leadInSec', 'overlapToWide', 'output'];

  var BUILTIN = [
    { id: 'sleepy', name: 'Sleepy', blurb: 'long shots', builtin: true,
      settings: { sensitivityDb: 12, minTalkSec: 1.6, minShotSec: 4, maxShotSec: 40, wideShotSec: 4, leadInSec: 0.3, overlapToWide: true } },
    { id: 'chatty', name: 'Chatty', blurb: 'follows talk', builtin: true,
      settings: { sensitivityDb: 10, minTalkSec: 1.2, minShotSec: 2.5, maxShotSec: 25, wideShotSec: 3, leadInSec: 0.2, overlapToWide: true } },
    { id: 'chaotic', name: 'Chaotic', blurb: 'snip snip', builtin: true,
      settings: { sensitivityDb: 9, minTalkSec: 0.7, minShotSec: 1.2, maxShotSec: 12, wideShotSec: 2, leadInSec: 0.1, overlapToWide: true } }
  ];

  function pick(settings) {
    var out = {};
    for (var i = 0; i < KEYS.length; i++) {
      if (settings && settings[KEYS[i]] !== undefined) out[KEYS[i]] = settings[KEYS[i]];
    }
    return out;
  }

  function slug(name) {
    return 'custom-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  function createStore(backend) {
    function readCustom() {
      try {
        var data = JSON.parse(backend.read() || '[]');
        return Array.isArray(data) ? data.filter(function (p) { return p && p.id && p.name && p.settings; }) : [];
      } catch (e) {
        return [];
      }
    }
    function writeCustom(list) { backend.write(JSON.stringify(list, null, 2)); }

    return {
      list: function () { return BUILTIN.concat(readCustom()); },
      get: function (id) {
        var all = this.list();
        for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
        return null;
      },
      // Saving under an existing custom name overwrites it; built-in names get "(mine)".
      save: function (name, settings) {
        name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!name) throw new Error('A preset needs a name.');
        for (var b = 0; b < BUILTIN.length; b++) {
          if (BUILTIN[b].name.toLowerCase() === name.toLowerCase()) name += ' (mine)';
        }
        var list = readCustom();
        var preset = { id: slug(name), name: name, blurb: 'yours', settings: pick(settings) };
        var replaced = false;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === preset.id) { list[i] = preset; replaced = true; }
        }
        if (!replaced) list.push(preset);
        writeCustom(list);
        return preset;
      },
      remove: function (id) {
        var list = readCustom(), kept = [], removed = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === id) removed = list[i]; else kept.push(list[i]);
        }
        if (removed) writeCustom(kept);
        return removed;
      }
    };
  }

  // Which preset (if any) the current settings exactly match.
  function matching(presets, settings) {
    for (var i = 0; i < presets.length; i++) {
      var s = presets[i].settings, same = true;
      for (var k in s) {
        if (s.hasOwnProperty(k) && k !== 'output' && s[k] !== settings[k]) same = false;
      }
      if (same) return presets[i].id;
    }
    return null;
  }

  return { KEYS: KEYS, BUILTIN: BUILTIN, createStore: createStore, matching: matching, pick: pick };
});
