/**
 * Intelligence Dynamics GCP lifecycle controller.
 *
 * Control plane: Google Sheet written by ChatGPT/recurring automation.
 * Executor: Google Apps Script time trigger, running as the sheet/controller owner.
 *
 * Security/safety:
 * - target VM name is compile-time fixed;
 * - only RUNNING / TERMINATED desired states exist;
 * - no arbitrary URL, project, zone, instance, or shell from the sheet;
 * - RUNNING requires an unexpired bounded lease;
 * - expired/missing lease is interpreted as TERMINATED;
 * - generation is monotonic to prevent stale rollback;
 * - provider calls are idempotent against current VM state;
 * - controller errors never cause a start.
 */

const CFG = Object.freeze({
  SPREADSHEET_ID: '109ku6C4j32g5KDUVe8gPjPJrkwqlTxlrQ-BzLF0GuAk',
  SHEET_NAME: 'control',
  INSTANCE_NAME: 'intelligence-dynamics-worker',
  MAX_LEASE_MINUTES: 370,
  PROJECT_SEARCH_PAGE_SIZE: 200,
  COMPUTE_PAGE_SIZE: 500,
  STATUS_RANGE: 'D2:D14',
});

function nowIso_() {
  return new Date().toISOString();
}

function oauthHeaders_() {
  return {
    Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    Accept: 'application/json',
  };
}

function fetchJson_(url, options) {
  const opts = Object.assign({
    method: 'get',
    muteHttpExceptions: true,
    headers: oauthHeaders_(),
  }, options || {});
  const started = Date.now();
  const resp = UrlFetchApp.fetch(url, opts);
  const latencyMs = Date.now() - started;
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  let payload = {};
  if (text) {
    try { payload = JSON.parse(text); }
    catch (e) { payload = {raw: text}; }
  }
  return {code: code, payload: payload, latencyMs: latencyMs};
}

function sheet_() {
  const ss = SpreadsheetApp.openById(CFG.SPREADSHEET_ID);
  const sh = ss.getSheetByName(CFG.SHEET_NAME);
  if (!sh) throw new Error('control sheet not found');
  return sh;
}

function readControl_() {
  const sh = sheet_();
  const values = sh.getRange('A1:B14').getValues();
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const k = String(values[i][0] || '').trim();
    if (k) map[k] = values[i][1];
  }

  if (Number(map.schema_version) !== 1) throw new Error('unsupported schema_version');
  if (String(map.target_instance) !== CFG.INSTANCE_NAME) throw new Error('target_instance mismatch');
  if (String(map.mode) !== 'FAIL_CLOSED') throw new Error('mode must be FAIL_CLOSED');

  const desired = String(map.desired_state || '').trim();
  if (desired !== 'RUNNING' && desired !== 'TERMINATED') {
    throw new Error('desired_state must be RUNNING or TERMINATED');
  }

  const generation = Number(map.generation);
  if (!Number.isInteger(generation) || generation < 1) throw new Error('generation must be a positive integer');

  const configuredMax = Number(map.max_lease_minutes);
  if (!Number.isFinite(configuredMax) || configuredMax < 1 || configuredMax > CFG.MAX_LEASE_MINUTES) {
    throw new Error('max_lease_minutes outside controller bound');
  }

  const leaseRaw = String(map.lease_until_utc || '').trim();
  let leaseUntilMs = null;
  if (leaseRaw) {
    leaseUntilMs = Date.parse(leaseRaw);
    if (!Number.isFinite(leaseUntilMs)) throw new Error('invalid lease_until_utc');
  }

  return {
    desiredState: desired,
    generation: generation,
    requestedAtUtc: String(map.requested_at_utc || ''),
    leaseUntilUtc: leaseRaw,
    leaseUntilMs: leaseUntilMs,
    projectIdHint: String(map.project_id_hint || 'AUTO').trim(),
    maxLeaseMinutes: configuredMax,
    reason: String(map.reason || ''),
  };
}

function effectiveDesiredState_(ctl, nowMs) {
  if (ctl.desiredState !== 'RUNNING') return 'TERMINATED';
  if (!ctl.leaseUntilMs) return 'TERMINATED';
  if (ctl.leaseUntilMs <= nowMs) return 'TERMINATED';

  const requestedMs = Date.parse(ctl.requestedAtUtc);
  if (!Number.isFinite(requestedMs)) return 'TERMINATED';

  const maxLeaseMs = ctl.maxLeaseMinutes * 60 * 1000;
  if ((ctl.leaseUntilMs - requestedMs) > maxLeaseMs) return 'TERMINATED';
  if (requestedMs > nowMs + 5 * 60 * 1000) return 'TERMINATED';
  return 'RUNNING';
}

function providerPlan_(effectiveState, providerStatus) {
  const desired = String(effectiveState || '').toUpperCase();
  const status = String(providerStatus || '').toUpperCase();
  if (desired !== 'RUNNING' && desired !== 'TERMINATED') {
    throw new Error('invalid effective state');
  }
  if (!status) throw new Error('provider status required');

  if (desired === 'RUNNING') {
    if (status === 'TERMINATED') {
      return {action:'start', target:'RUNNING', operation:'START_REQUIRED'};
    }
    if (['RUNNING','STAGING','PROVISIONING','REPAIRING'].indexOf(status) >= 0) {
      return {action:'none', target:'RUNNING', operation:'START_IDEMPOTENT_' + status};
    }
    if (status === 'STOPPING' || status === 'SUSPENDING') {
      return {action:'none', target:'TERMINATED', operation:'START_DEFERRED_' + status};
    }
    if (status === 'SUSPENDED') {
      return {action:'stop', target:'TERMINATED', operation:'START_DEFERRED_SUSPENDED_STOP_REQUIRED'};
    }
    throw new Error('unknown provider status: ' + status);
  }

  if (status === 'TERMINATED' || status === 'STOPPING') {
    return {action:'none', target:'TERMINATED', operation:'STOP_IDEMPOTENT_' + status};
  }
  return {action:'stop', target:'TERMINATED', operation:'STOP_REQUIRED_' + status};
}

function listProjects_() {
  const projects = [];
  let token = '';
  do {
    let url = 'https://cloudresourcemanager.googleapis.com/v3/projects:search'
      + '?pageSize=' + encodeURIComponent(String(CFG.PROJECT_SEARCH_PAGE_SIZE))
      + '&query=' + encodeURIComponent('state:ACTIVE');
    if (token) url += '&pageToken=' + encodeURIComponent(token);
    const r = fetchJson_(url);
    if (r.code !== 200) throw new Error('project search failed HTTP ' + r.code + ': ' + JSON.stringify(r.payload));
    (r.payload.projects || []).forEach(function(p) {
      if (p.projectId) projects.push(String(p.projectId));
    });
    token = String(r.payload.nextPageToken || '');
  } while (token);
  return projects;
}

function findInstanceInProject_(projectId) {
  let token = '';
  const hits = [];
  do {
    let url = 'https://compute.googleapis.com/compute/v1/projects/'
      + encodeURIComponent(projectId)
      + '/aggregated/instances?returnPartialSuccess=true&maxResults='
      + encodeURIComponent(String(CFG.COMPUTE_PAGE_SIZE));
    if (token) url += '&pageToken=' + encodeURIComponent(token);
    const r = fetchJson_(url);
    if (r.code === 403 || r.code === 404) return [];
    if (r.code !== 200) throw new Error('aggregated instances failed for ' + projectId + ' HTTP ' + r.code);

    const items = r.payload.items || {};
    Object.keys(items).forEach(function(scope) {
      const instances = (items[scope] && items[scope].instances) || [];
      instances.forEach(function(vm) {
        if (vm.name === CFG.INSTANCE_NAME) {
          hits.push({
            projectId: projectId,
            name: vm.name,
            id: String(vm.id || ''),
            zone: String(vm.zone || '').split('/').pop(),
            status: String(vm.status || ''),
            lastStartTimestamp: vm.lastStartTimestamp || '',
            lastStopTimestamp: vm.lastStopTimestamp || '',
          });
        }
      });
    });
    token = String(r.payload.nextPageToken || '');
  } while (token);
  return hits;
}

function findInstance_() {
  const props = PropertiesService.getScriptProperties();
  const cachedProject = props.getProperty('CACHED_PROJECT_ID');
  const cachedZone = props.getProperty('CACHED_ZONE');

  if (cachedProject && cachedZone) {
    const direct = getInstance_(cachedProject, cachedZone);
    if (direct && direct.name === CFG.INSTANCE_NAME) return direct;
    props.deleteProperty('CACHED_PROJECT_ID');
    props.deleteProperty('CACHED_ZONE');
  }

  const ctl = readControl_();
  let projects = [];
  if (ctl.projectIdHint && ctl.projectIdHint !== 'AUTO') {
    projects = [ctl.projectIdHint];
  } else {
    projects = listProjects_();
  }

  const hits = [];
  projects.forEach(function(projectId) {
    findInstanceInProject_(projectId).forEach(function(hit) { hits.push(hit); });
  });

  if (hits.length === 0) throw new Error('instance not found: ' + CFG.INSTANCE_NAME);
  if (hits.length > 1) throw new Error('instance name is ambiguous across projects');

  props.setProperty('CACHED_PROJECT_ID', hits[0].projectId);
  props.setProperty('CACHED_ZONE', hits[0].zone);
  return hits[0];
}

function getInstance_(projectId, zone) {
  const url = 'https://compute.googleapis.com/compute/v1/projects/'
    + encodeURIComponent(projectId)
    + '/zones/' + encodeURIComponent(zone)
    + '/instances/' + encodeURIComponent(CFG.INSTANCE_NAME);
  const r = fetchJson_(url);
  if (r.code === 404) return null;
  if (r.code !== 200) throw new Error('instances.get failed HTTP ' + r.code + ': ' + JSON.stringify(r.payload));
  const vm = r.payload;
  return {
    projectId: projectId,
    name: vm.name,
    id: String(vm.id || ''),
    zone: String(vm.zone || '').split('/').pop(),
    status: String(vm.status || ''),
    lastStartTimestamp: vm.lastStartTimestamp || '',
    lastStopTimestamp: vm.lastStopTimestamp || '',
  };
}

function waitForStatus_(vm, targetStatus, timeoutMs) {
  const deadline = Date.now() + Math.min(Number(timeoutMs || 45000), 45000);
  let current = vm;
  while (Date.now() <= deadline) {
    current = getInstance_(vm.projectId, vm.zone);
    if (!current) throw new Error('instance disappeared during provider verification');
    if (current.status === targetStatus) {
      return current;
    }
    Utilities.sleep(2000);
  }
  throw new Error(
    'provider state timeout: target=' + targetStatus
    + ' current=' + (current ? current.status : 'UNKNOWN')
  );
}

function mutateInstance_(vm, action) {
  if (action !== 'start' && action !== 'stop') throw new Error('unsupported provider action');
  const url = 'https://compute.googleapis.com/compute/v1/projects/'
    + encodeURIComponent(vm.projectId)
    + '/zones/' + encodeURIComponent(vm.zone)
    + '/instances/' + encodeURIComponent(CFG.INSTANCE_NAME)
    + '/' + action;
  const r = fetchJson_(url, {method: 'post', contentType: 'application/json', payload: '{}'});
  if (r.code !== 200) throw new Error(action + ' failed HTTP ' + r.code + ': ' + JSON.stringify(r.payload));
  return {operation: r.payload, latencyMs: r.latencyMs};
}

function appendAudit_(entry) {
  const ss = SpreadsheetApp.openById(CFG.SPREADSHEET_ID);
  const sh = ss.getSheetByName('audit');
  if (!sh) throw new Error('audit sheet not found');
  sh.appendRow([
    entry.atUtc || nowIso_(),
    Number(entry.generation || 0),
    entry.desiredState || '',
    entry.effectiveState || '',
    entry.providerStatus || '',
    entry.operation || '',
    entry.projectId || '',
    entry.zone || '',
    Number(entry.latencyMs || 0),
    entry.error || '',
  ]);
}

function writeStatus_(status) {
  const sh = sheet_();
  const rows = [
    [status.controllerStatus || ''],
    [status.providerStatus || ''],
    [status.projectId || ''],
    [status.zone || ''],
    [status.instanceId || ''],
    [status.lastReconcileAtUtc || ''],
    [status.lastOperation || ''],
    [status.lastError || ''],
    [Number(status.appliedGeneration || 0)],
    [status.lastStartTimestamp || ''],
    [status.lastStopTimestamp || ''],
    [status.effectiveDesiredState || 'TERMINATED'],
    [Number(status.lastPollLatencyMs || 0)],
  ];
  sh.getRange(CFG.STATUS_RANGE).setValues(rows);
}

function reconcile() {
  const started = Date.now();
  const props = PropertiesService.getScriptProperties();
  let ctl = null;
  let vm = null;
  let effective = 'TERMINATED';
  let operation = 'NONE';
  let error = '';

  try {
    ctl = readControl_();
    effective = effectiveDesiredState_(ctl, Date.now());

    const lastSeen = Number(props.getProperty('LAST_SEEN_GENERATION') || '0');
    if (ctl.generation < lastSeen) {
      throw new Error('stale generation rollback rejected');
    }
    props.setProperty('LAST_SEEN_GENERATION', String(ctl.generation));
    props.setProperty('LAST_EFFECTIVE_DESIRED_STATE', effective);
    props.setProperty('LAST_LEASE_UNTIL_UTC', ctl.leaseUntilUtc || '');

    vm = findInstance_();

    const plan = providerPlan_(effective, vm.status);
    operation = plan.operation;

    if (plan.action === 'start') {
      mutateInstance_(vm, 'start');
      operation = 'START_ACCEPTED';
    } else if (plan.action === 'stop') {
      mutateInstance_(vm, 'stop');
      operation = effective === 'TERMINATED'
        ? 'STOP_ACCEPTED'
        : 'START_DEFERRED_SUSPENDED_STOP_ACCEPTED';
    }

    if (vm.status !== plan.target || plan.action !== 'none') {
      vm = waitForStatus_(vm, plan.target, 45000);
    }

    props.setProperty('LAST_APPLIED_GENERATION', String(ctl.generation));
    props.setProperty('LAST_OPERATION', operation);
    const completedAt = nowIso_();
    const elapsedMs = Date.now() - started;
    writeStatus_({
      controllerStatus: 'ACTIVE',
      providerStatus: vm.status,
      projectId: vm.projectId,
      zone: vm.zone,
      instanceId: vm.id,
      lastReconcileAtUtc: completedAt,
      lastOperation: operation,
      lastError: '',
      appliedGeneration: ctl.generation,
      lastStartTimestamp: vm.lastStartTimestamp,
      lastStopTimestamp: vm.lastStopTimestamp,
      effectiveDesiredState: effective,
      lastPollLatencyMs: elapsedMs,
    });
    appendAudit_({
      atUtc: completedAt,
      generation: ctl.generation,
      desiredState: ctl.desiredState,
      effectiveState: effective,
      providerStatus: vm.status,
      operation: operation,
      projectId: vm.projectId,
      zone: vm.zone,
      latencyMs: elapsedMs,
      error: '',
    });
  } catch (e) {
    error = String(e && e.message ? e.message : e);
    props.setProperty('LAST_ERROR', error);

    // Fail closed: a control-plane error is never allowed to cause a start.
    // If we have cached provider coordinates and the last known lease is expired
    // or absent, make one best-effort stop attempt before surfacing the error.
    try {
      const cachedProject = props.getProperty('CACHED_PROJECT_ID');
      const cachedZone = props.getProperty('CACHED_ZONE');
      const lease = props.getProperty('LAST_LEASE_UNTIL_UTC') || '';
      const leaseMs = lease ? Date.parse(lease) : NaN;
      const shouldStop = !Number.isFinite(leaseMs) || leaseMs <= Date.now();
      if (cachedProject && cachedZone && shouldStop) {
        const cachedVm = getInstance_(cachedProject, cachedZone);
        if (cachedVm && cachedVm.status !== 'TERMINATED' && cachedVm.status !== 'STOPPING') {
          mutateInstance_(cachedVm, 'stop');
          operation = 'ERROR_FAIL_CLOSED_STOP_ACCEPTED';
          vm = cachedVm;
        }
      }
    } catch (stopErr) {
      error += ' | fail-closed stop failed: ' + String(stopErr && stopErr.message ? stopErr.message : stopErr);
    }

    try {
      const failedAt = nowIso_();
      const failedElapsedMs = Date.now() - started;
      writeStatus_({
        controllerStatus: 'ERROR',
        providerStatus: vm ? vm.status : 'UNKNOWN',
        projectId: vm ? vm.projectId : (props.getProperty('CACHED_PROJECT_ID') || ''),
        zone: vm ? vm.zone : (props.getProperty('CACHED_ZONE') || ''),
        instanceId: vm ? vm.id : '',
        lastReconcileAtUtc: failedAt,
        lastOperation: operation,
        lastError: error,
        appliedGeneration: Number(props.getProperty('LAST_APPLIED_GENERATION') || '0'),
        lastStartTimestamp: vm ? vm.lastStartTimestamp : '',
        lastStopTimestamp: vm ? vm.lastStopTimestamp : '',
        effectiveDesiredState: effective,
        lastPollLatencyMs: failedElapsedMs,
      });
      appendAudit_({
        atUtc: failedAt,
        generation: ctl ? ctl.generation : 0,
        desiredState: ctl ? ctl.desiredState : '',
        effectiveState: effective,
        providerStatus: vm ? vm.status : 'UNKNOWN',
        operation: operation,
        projectId: vm ? vm.projectId : (props.getProperty('CACHED_PROJECT_ID') || ''),
        zone: vm ? vm.zone : (props.getProperty('CACHED_ZONE') || ''),
        latencyMs: failedElapsedMs,
        error: error,
      });
    } catch (_) {}
    throw e;
  }
}

function installController() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'reconcile') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('reconcile').timeBased().everyMinutes(1).create();
  reconcile();
}

function uninstallController() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'reconcile') ScriptApp.deleteTrigger(t);
  });
}

function controllerSelfTest() {
  const cases = [
    {
      name: 'terminated always stops',
      ctl: {desiredState:'TERMINATED', leaseUntilMs:null, requestedAtUtc:'', maxLeaseMinutes:370},
      expected:'TERMINATED'
    },
    {
      name: 'running without lease fails closed',
      ctl: {desiredState:'RUNNING', leaseUntilMs:null, requestedAtUtc:nowIso_(), maxLeaseMinutes:370},
      expected:'TERMINATED'
    },
    {
      name: 'expired lease fails closed',
      ctl: {desiredState:'RUNNING', leaseUntilMs:Date.now()-1000, requestedAtUtc:new Date(Date.now()-60000).toISOString(), maxLeaseMinutes:370},
      expected:'TERMINATED'
    },
    {
      name: 'valid bounded lease runs',
      ctl: {desiredState:'RUNNING', leaseUntilMs:Date.now()+5*60000, requestedAtUtc:nowIso_(), maxLeaseMinutes:370},
      expected:'RUNNING'
    },
    {
      name: 'oversized lease fails closed',
      ctl: {desiredState:'RUNNING', leaseUntilMs:Date.now()+371*60000, requestedAtUtc:nowIso_(), maxLeaseMinutes:370},
      expected:'TERMINATED'
    },
  ];
  const failures = [];
  cases.forEach(function(c) {
    const got = effectiveDesiredState_(c.ctl, Date.now());
    if (got !== c.expected) failures.push(c.name + ': got ' + got + ', want ' + c.expected);
  });

  const providerCases = [
    ['RUNNING','TERMINATED','start','RUNNING'],
    ['RUNNING','RUNNING','none','RUNNING'],
    ['RUNNING','STOPPING','none','TERMINATED'],
    ['RUNNING','SUSPENDED','stop','TERMINATED'],
    ['TERMINATED','RUNNING','stop','TERMINATED'],
    ['TERMINATED','TERMINATED','none','TERMINATED'],
  ];
  providerCases.forEach(function(pc) {
    const got = providerPlan_(pc[0], pc[1]);
    if (got.action !== pc[2] || got.target !== pc[3]) {
      failures.push(
        'provider plan ' + pc[0] + '/' + pc[1]
        + ': got ' + JSON.stringify(got)
      );
    }
  });

  if (failures.length) throw new Error('self-test failed: ' + failures.join('; '));
  return 'PASS ' + (cases.length + providerCases.length);
}
