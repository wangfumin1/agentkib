/**
 * One-time Apps Script bootstrap for the external GCP lifecycle controller.
 *
 * The maintained controller module is stored in the private Google Sheet
 * "Intelligence Dynamics - GCP Lifecycle Control", hidden tab "source".
 * This small bootstrap stays stable; ChatGPT/automation can update the module
 * through the already-connected Google Sheets integration without redeploying
 * this script.
 */

const ID_CONTROL_SHEET_ID = '109ku6C4j32g5KDUVe8gPjPJrkwqlTxlrQ-BzLF0GuAk';

function loadControllerModule_() {
  const ss = SpreadsheetApp.openById(ID_CONTROL_SHEET_ID);
  const sh = ss.getSheetByName('source');
  if (!sh) throw new Error('controller source sheet missing');
  const source = String(sh.getRange('A1').getValue() || '');
  if (source.length < 1000 || source.length > 49000) {
    throw new Error('controller source length outside safety bounds');
  }
  const module = eval(source);
  if (!module || typeof module.reconcile !== 'function' || typeof module.selfTest !== 'function') {
    throw new Error('controller module interface invalid');
  }
  return module;
}

function reconcile() {
  return loadControllerModule_().reconcile();
}

function controllerSelfTest() {
  return loadControllerModule_().selfTest();
}

function installController() {
  const test = controllerSelfTest();
  if (!String(test).startsWith('PASS')) {
    throw new Error('controller self-test did not pass: ' + String(test));
  }

  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'reconcile') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('reconcile').timeBased().everyMinutes(1).create();

  // Desired state is initialized as TERMINATED. First reconcile therefore
  // performs provider discovery/status verification without starting compute.
  return reconcile();
}

function uninstallController() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'reconcile') ScriptApp.deleteTrigger(t);
  });
}
