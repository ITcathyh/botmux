#!/usr/bin/env node

/**
 * Prove which Session mutation paths are behind SessionRuntime and which ones
 * remain explicit Target-A bypasses. The checked-in ledger is descriptive;
 * source and the A0 authority inventory are the evidence.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const ledgerPath = resolve(repoRoot, 'docs/architecture/session-runtime-coverage.json');
const authorityInventoryRelativePath = 'docs/architecture/session-authority-inventory.json';
const authorityInventoryPath = resolve(repoRoot, authorityInventoryRelativePath);

const expectedCoverage = new Map([
  ['keyed-trigger-start', { targetMilestone: 'A1', disposition: 'migrated' }],
  ['current-session-store-adapter', { targetMilestone: 'A1', disposition: 'migrated' }],
  ['ordinary-im', { targetMilestone: 'C1', disposition: 'remaining' }],
  ['control', { targetMilestone: 'C2', disposition: 'remaining' }],
  ['executor-generation', { targetMilestone: 'A2', disposition: 'migrated' }],
  ['scheduler', { targetMilestone: 'C4', disposition: 'remaining' }],
  ['activation-restore', { targetMilestone: 'A4', disposition: 'remaining' }],
  ['path-specific-retained', { targetMilestone: 'Target-A', disposition: 'retained' }],
  ['projection', { targetMilestone: 'C3', disposition: 'remaining' }],
  ['remaining-bypass', { targetMilestone: 'Target-A', disposition: 'remaining' }],
]);

const retainedForbiddenAccessLanes = new Set([
  'direct-caller-mutation',
  'session-store-api',
]);

const mandatoryForbiddenCalls = [
  'sessionStore.createSession',
  'sessionStore.createSessionExact',
  'sessionStore.updateSession',
  'sessionStore.closeSession',
  'activeSessions.set',
  'activeSessions.delete',
  'forkWorker',
  'forkSession',
  'closeSession',
];
const mandatoryPureRuntimeSources = ['src/core/session-runtime.ts'];
const mandatoryForbiddenImports = ['../services/session-store.js', './worker-pool.js'];
const executorRuntimeAccessLane = 'session-executor-runtime-adapter';
const mandatoryExecutorObservationKinds = [
  'inputReceived',
  'inputRejected',
  'inputCommitted',
  'turnTerminal',
  'cliExit',
  'workerExit',
];
const mandatoryExecutorSelectors = new Map([
  ['src/core/current-session-executor-runtime.ts', [
    'commitNext',
    'fenceExit',
    'reconcilePendingExitFence',
    'reconcilePendingReservation',
  ]],
  ['src/core/current-dispatch-input-commit-evidence.ts', [
    'record',
    'synchronizeReceipts',
  ]],
  ['src/core/dispatch.ts', ['recordDispatchInputCommit']],
  ['src/core/worker-pool.ts', [
    'retireWorkerAfterUnknownGeneration',
    'setupWorkerHandlers',
  ]],
  ['src/core/trigger-session.ts', ['convergeIdempotentAsyncTurnOnWorkerExit']],
]);

let cachedFacts;
const parsedSources = new Map();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function siteIdentity(site) {
  return `${site.sourceFile}#${site.enclosingFunction}`
    + ` :: ${site.receiverKind}.${site.fieldPath}`
    + ` :: ${site.operation}`
    + ` :: ${site.normalizedAstHash}`;
}

function selectedSiteFacts(sites) {
  const records = [...sites].sort((left, right) => siteIdentity(left).localeCompare(siteIdentity(right)));
  return {
    recordCount: records.length,
    mutationCount: records.reduce((sum, site) => sum + site.count, 0),
    digest: sha256(records.map(site => `${siteIdentity(site)} :: ${site.count}`).join('\0')),
  };
}

function rawPublisherIdentity(writer) {
  return `${writer.sourceFile}#${writer.enclosingFunction}`
    + ` :: ${writer.authorityId}`
    + ` :: ${writer.siteCount}`
    + ` :: ${writer.siteDigest}`
    + ` :: ${writer.functionDigest}`;
}

function selectedRawPublisherFacts(writers) {
  const records = [...writers].sort((left, right) => (
    rawPublisherIdentity(left).localeCompare(rawPublisherIdentity(right))
  ));
  return {
    recordCount: records.length,
    publishSiteCount: records.reduce((sum, writer) => sum + writer.siteCount, 0),
    digest: sha256(records.map(rawPublisherIdentity).join('\0')),
  };
}

function loadFacts() {
  if (cachedFacts) return cachedFacts;
  // `build` runs the source census first. This audit binds every coverage claim
  // to that reviewed snapshot instead of running a second, divergent scanner.
  const authorityRaw = readFileSync(authorityInventoryPath, 'utf8');
  const authorityInventory = JSON.parse(authorityRaw);
  cachedFacts = {
    authorityRaw,
    authorityInventory,
    sites: authorityInventory.mutationSites,
    rawPublishers: authorityInventory.scanner.rawSessionFileWriters,
    authorityClassifications: new Map(
      authorityInventory.authorities.map(authority => [authority.id, authority.classification]),
    ),
  };
  return cachedFacts;
}

function validateStringArray(value, label, { allowEmpty = false } = {}) {
  assert(Array.isArray(value), `${label} must be an array`);
  assert(allowEmpty || value.length > 0, `${label} must not be empty`);
  const seen = new Set();
  for (const item of value) {
    assert(typeof item === 'string' && item.length > 0, `${label} must contain non-empty strings`);
    assert(!seen.has(item), `${label} contains duplicate value: ${item}`);
    seen.add(item);
  }
}

function validateLedgerSchema(ledger) {
  assert(isPlainObject(ledger), 'SessionRuntime coverage ledger must be an object');
  assert(ledger.schemaVersion === 1, 'unsupported SessionRuntime coverage schemaVersion');
  assert(isPlainObject(ledger.authorityInventory), 'authorityInventory must be an object');
  assert(
    ledger.authorityInventory.path === authorityInventoryRelativePath,
    `authorityInventory.path must be ${authorityInventoryRelativePath}`,
  );
  assert(
    typeof ledger.authorityInventory.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(ledger.authorityInventory.sha256),
    'authorityInventory.sha256 must be a SHA-256 digest',
  );
  assert(Array.isArray(ledger.coverage), 'coverage must be an array');
  assert(ledger.coverage.length === expectedCoverage.size, 'coverage must contain every required path');

  const ids = new Set();
  for (const entry of ledger.coverage) {
    assert(isPlainObject(entry), 'each coverage entry must be an object');
    assert(typeof entry.id === 'string' && entry.id.length > 0, 'coverage entry id must be non-empty');
    assert(!ids.has(entry.id), `duplicate coverage entry id: ${entry.id}`);
    ids.add(entry.id);
    const expected = expectedCoverage.get(entry.id);
    assert(expected, `unknown coverage entry id: ${entry.id}`);
    assert(
      Object.prototype.hasOwnProperty.call(entry, 'targetMilestone'),
      `${entry.id}.targetMilestone is required`,
    );
    assert(
      entry.targetMilestone === expected.targetMilestone,
      `${entry.id}.targetMilestone must be ${expected.targetMilestone ?? 'null'}`,
    );
    assert(
      entry.disposition === expected.disposition,
      `${entry.id}.disposition must be ${expected.disposition}`,
    );
    assert(typeof entry.description === 'string' && entry.description.length > 0, `${entry.id}.description is required`);
    const rawPublisherOnly = entry.id === 'current-session-store-adapter';
    assert(Array.isArray(entry.selectors), `${entry.id}.selectors must be an array`);
    assert(
      rawPublisherOnly ? entry.selectors.length === 0 : entry.selectors.length > 0,
      rawPublisherOnly
        ? `${entry.id}.selectors must stay empty while the inventory exposes only its raw publisher`
        : `${entry.id}.selectors must not be empty`,
    );
    assert(isPlainObject(entry.authoritySites), `${entry.id}.authoritySites must be an object`);
    assert(
      Number.isInteger(entry.authoritySites.recordCount)
        && (rawPublisherOnly
          ? entry.authoritySites.recordCount === 0
          : entry.authoritySites.recordCount > 0),
      `${entry.id}.authoritySites.recordCount must be ${rawPublisherOnly ? 'zero' : 'positive'}`,
    );
    assert(
      Number.isInteger(entry.authoritySites.mutationCount)
        && (rawPublisherOnly
          ? entry.authoritySites.mutationCount === 0
          : entry.authoritySites.mutationCount > 0),
      `${entry.id}.authoritySites.mutationCount must be ${rawPublisherOnly ? 'zero' : 'positive'}`,
    );
    assert(
      typeof entry.authoritySites.digest === 'string'
        && /^[a-f0-9]{64}$/.test(entry.authoritySites.digest),
      `${entry.id}.authoritySites.digest must be a SHA-256 digest`,
    );
    for (const selector of entry.selectors) validateSelectorSchema(selector, entry.id);

    const bindsRawPublishers = entry.id === 'current-session-store-adapter'
      || entry.id === 'path-specific-retained'
      || entry.id === 'remaining-bypass';
    if (bindsRawPublishers) {
      assert(
        Array.isArray(entry.rawPublisherSelectors) && entry.rawPublisherSelectors.length > 0,
        `${entry.id}.rawPublisherSelectors must not be empty`,
      );
      for (const selector of entry.rawPublisherSelectors) {
        validateRawPublisherSelectorSchema(selector, entry.id);
      }
      assert(isPlainObject(entry.authorityRawPublishers), `${entry.id}.authorityRawPublishers must be an object`);
      assert(
        Number.isInteger(entry.authorityRawPublishers.recordCount)
          && entry.authorityRawPublishers.recordCount > 0,
        `${entry.id}.authorityRawPublishers.recordCount must be positive`,
      );
      assert(
        Number.isInteger(entry.authorityRawPublishers.publishSiteCount)
          && entry.authorityRawPublishers.publishSiteCount > 0,
        `${entry.id}.authorityRawPublishers.publishSiteCount must be positive`,
      );
      assert(
        typeof entry.authorityRawPublishers.digest === 'string'
          && /^[a-f0-9]{64}$/.test(entry.authorityRawPublishers.digest),
        `${entry.id}.authorityRawPublishers.digest must be a SHA-256 digest`,
      );
    } else {
      assert(entry.rawPublisherSelectors === undefined, `${entry.id} must not select raw Session publishers`);
      assert(entry.authorityRawPublishers === undefined, `${entry.id} must not bind raw Session publishers`);
    }
  }
  for (const id of expectedCoverage.keys()) assert(ids.has(id), `missing coverage entry: ${id}`);

  const keyedTrigger = ledger.coverage.find(entry => entry.id === 'keyed-trigger-start');
  validateKeyedProductionBindingSchema(keyedTrigger.productionBinding);
  const executor = ledger.coverage.find(entry => entry.id === 'executor-generation');
  validateExecutorSelectors(executor.selectors);
  validateExecutorProductionBindingSchema(executor.productionBinding);
  for (const entry of ledger.coverage) {
    if (entry.id !== 'keyed-trigger-start' && entry.id !== 'executor-generation') {
      assert(entry.productionBinding === undefined, `${entry.id} must not claim a migrated production binding`);
    }
  }
}

function validateRawPublisherSelectorSchema(selector, entryId) {
  assert(isPlainObject(selector), `${entryId} raw publisher selector must be an object`);
  if (selector.inventoryRemainder === true) {
    const allowedKeys = new Set(['inventoryRemainder', 'authorityClassifications']);
    for (const key of Object.keys(selector)) {
      assert(allowedKeys.has(key), `${entryId} raw publisher remainder has unsupported field: ${key}`);
    }
    assert(
      entryId === 'path-specific-retained' || entryId === 'remaining-bypass',
      'only path-specific-retained or remaining-bypass may select the raw publisher remainder',
    );
    if (entryId === 'path-specific-retained') {
      validateStringArray(
        selector.authorityClassifications,
        `${entryId} raw publisher selector.authorityClassifications`,
      );
      assert(
        selector.authorityClassifications.length === 1
          && selector.authorityClassifications[0] === 'path_specific_authority',
        `${entryId} raw publisher remainder must select only path_specific_authority`,
      );
    } else {
      assert(
        Object.keys(selector).length === 1,
        `${entryId} raw publisher remainder must be the final unfiltered bypass remainder`,
      );
    }
    return;
  }
  const allowedKeys = new Set(['sourceFile', 'enclosingFunctions', 'authorityIds']);
  for (const key of Object.keys(selector)) {
    assert(allowedKeys.has(key), `${entryId} raw publisher selector has unsupported field: ${key}`);
  }
  assert(
    typeof selector.sourceFile === 'string' && selector.sourceFile.startsWith('src/'),
    `${entryId} raw publisher selector.sourceFile must name src/`,
  );
  if (selector.enclosingFunctions !== undefined) {
    validateStringArray(selector.enclosingFunctions, `${entryId} raw publisher selector.enclosingFunctions`);
  }
  if (selector.authorityIds !== undefined) {
    validateStringArray(selector.authorityIds, `${entryId} raw publisher selector.authorityIds`);
  }
}

function validateSelectorSchema(selector, entryId) {
  assert(isPlainObject(selector), `${entryId} selector must be an object`);
  if (selector.inventoryRemainder === true) {
    const allowedKeys = new Set(['inventoryRemainder', 'classifications', 'excludedAccessLanes']);
    for (const key of Object.keys(selector)) {
      assert(allowedKeys.has(key), `${entryId} inventory remainder has unsupported field: ${key}`);
    }
    assert(
      entryId === 'path-specific-retained'
        || entryId === 'projection'
        || entryId === 'remaining-bypass',
      'only the explicit retained/projection/bypass partitions may select the inventory remainder',
    );
    if (entryId === 'path-specific-retained') {
      validateStringArray(selector.classifications, `${entryId} selector.classifications`);
      validateStringArray(selector.excludedAccessLanes, `${entryId} selector.excludedAccessLanes`);
      assert(
        selector.classifications.length === 1
          && selector.classifications[0] === 'path_specific_authority',
        `${entryId} remainder must select only path_specific_authority`,
      );
      for (const lane of retainedForbiddenAccessLanes) {
        assert(
          selector.excludedAccessLanes.includes(lane),
          `${entryId} remainder must exclude ${lane}`,
        );
      }
    } else if (entryId === 'projection') {
      validateStringArray(selector.classifications, `${entryId} selector.classifications`);
      assert(
        selector.classifications.length === 1 && selector.classifications[0] === 'projection',
        'projection remainder must select only projection sites',
      );
      assert(
        selector.excludedAccessLanes === undefined,
        'projection remainder must not carry access-lane exclusions',
      );
    } else {
      assert(
        Object.keys(selector).length === 1,
        'remaining-bypass must be the final unfiltered inventory remainder',
      );
    }
    return;
  }
  const allowedKeys = new Set(['sourceFile', 'enclosingFunctions', 'accessLanes', 'authorityIds']);
  for (const key of Object.keys(selector)) {
    assert(allowedKeys.has(key), `${entryId} selector has unsupported field: ${key}`);
  }
  assert(typeof selector.sourceFile === 'string' && selector.sourceFile.startsWith('src/'), `${entryId} selector.sourceFile must name src/`);
  if (selector.enclosingFunctions !== undefined) {
    validateStringArray(selector.enclosingFunctions, `${entryId} selector.enclosingFunctions`);
  }
  if (selector.accessLanes !== undefined) {
    validateStringArray(selector.accessLanes, `${entryId} selector.accessLanes`);
  }
  if (selector.authorityIds !== undefined) {
    validateStringArray(selector.authorityIds, `${entryId} selector.authorityIds`);
  }
}

function validateKeyedProductionBindingSchema(binding) {
  assert(isPlainObject(binding), 'keyed-trigger-start.productionBinding must be an object');
  assert(typeof binding.sourceFile === 'string' && binding.sourceFile.startsWith('src/'), 'productionBinding.sourceFile must name src/');
  assert(typeof binding.enclosingFunction === 'string' && binding.enclosingFunction.length > 0, 'productionBinding.enclosingFunction is required');
  assert(binding.runtimeMethod === 'submit', 'productionBinding.runtimeMethod must be submit');
  assert(binding.commandKind === 'keyedTrigger.start', 'productionBinding.commandKind must be keyedTrigger.start');
  assert(binding.scope === 'nearestIf', 'productionBinding.scope must be nearestIf');
  validateStringArray(binding.forbiddenCalls, 'productionBinding.forbiddenCalls');
  validateStringArray(binding.pureRuntimeSources, 'productionBinding.pureRuntimeSources');
  validateStringArray(binding.forbiddenImports, 'productionBinding.forbiddenImports');
  for (const call of mandatoryForbiddenCalls) {
    assert(binding.forbiddenCalls.includes(call), `productionBinding.forbiddenCalls must include ${call}`);
  }
  for (const path of mandatoryPureRuntimeSources) {
    assert(binding.pureRuntimeSources.includes(path), `productionBinding.pureRuntimeSources must include ${path}`);
  }
  for (const path of mandatoryForbiddenImports) {
    assert(binding.forbiddenImports.includes(path), `productionBinding.forbiddenImports must include ${path}`);
  }
}

function sameStringSet(actual, expected) {
  return actual.length === expected.length
    && actual.every(value => expected.includes(value));
}

function validateExecutorSelectors(selectors) {
  assert(
    selectors.length === mandatoryExecutorSelectors.size,
    'executor-generation selectors must remain an exact production partition',
  );
  const seen = new Set();
  for (const selector of selectors) {
    const expectedFunctions = mandatoryExecutorSelectors.get(selector.sourceFile);
    assert(
      expectedFunctions,
      `executor-generation selector is not an exact reviewed source: ${selector.sourceFile}`,
    );
    assert(!seen.has(selector.sourceFile), `duplicate executor-generation selector: ${selector.sourceFile}`);
    seen.add(selector.sourceFile);
    assert(
      sameStringSet(selector.accessLanes ?? [], [executorRuntimeAccessLane]),
      `executor-generation selector ${selector.sourceFile} must use only the exact ${executorRuntimeAccessLane} access lane`,
    );
    assert(
      sameStringSet(selector.enclosingFunctions ?? [], expectedFunctions),
      `executor-generation selector ${selector.sourceFile} must name only its exact reviewed functions`,
    );
    assert(
      selector.authorityIds === undefined,
      `executor-generation selector ${selector.sourceFile} must not widen through authority IDs`,
    );
  }
}

function validateExecutorProductionBindingSchema(binding) {
  assert(isPlainObject(binding), 'executor-generation.productionBinding must be an object');
  for (const field of [
    'workerSource',
    'runtimeSource',
    'currentAdapterSource',
    'evidenceAdapterSource',
  ]) {
    assert(
      typeof binding[field] === 'string' && binding[field].startsWith('src/'),
      `executor-generation.productionBinding.${field} must name src/`,
    );
  }
  for (const field of ['handlerFunction', 'reservationFunction']) {
    assert(
      typeof binding[field] === 'string' && binding[field].length > 0,
      `executor-generation.productionBinding.${field} is required`,
    );
  }
  assert(
    binding.workerSource === 'src/core/worker-pool.ts',
    'executor-generation.productionBinding.workerSource must remain worker-pool',
  );
  assert(
    binding.handlerFunction === 'setupWorkerHandlers',
    'executor-generation.productionBinding.handlerFunction must remain setupWorkerHandlers',
  );
  assert(
    binding.reservationFunction === 'reserveWorkerGeneration',
    'executor-generation.productionBinding.reservationFunction must remain reserveWorkerGeneration',
  );
  assert(
    binding.runtimeSource === 'src/core/session-executor-runtime.ts',
    'executor-generation.productionBinding.runtimeSource must remain the pure internal Runtime',
  );
  assert(
    binding.currentAdapterSource === 'src/core/current-session-executor-runtime.ts',
    'executor-generation.productionBinding.currentAdapterSource must remain the Current generation Adapter',
  );
  assert(
    binding.evidenceAdapterSource === 'src/core/current-dispatch-input-commit-evidence.ts',
    'executor-generation.productionBinding.evidenceAdapterSource must remain the named evidence Adapter',
  );
  validateStringArray(
    binding.observationKinds,
    'executor-generation.productionBinding.observationKinds',
  );
  assert(
    sameStringSet(binding.observationKinds, mandatoryExecutorObservationKinds),
    'executor-generation.productionBinding.observationKinds must cover every executor observation',
  );
}

function selectAuthoritySites(selector, sites, assigned) {
  if (selector.inventoryRemainder === true) {
    return sites.filter(site => (
      !assigned.has(siteIdentity(site))
      && (!selector.classifications || selector.classifications.includes(site.classification))
      && (!selector.excludedAccessLanes
        || !selector.excludedAccessLanes.includes(site.accessLane))
    ));
  }
  const absolute = resolve(repoRoot, selector.sourceFile);
  assert(existsSync(absolute), `coverage selector source is missing: ${selector.sourceFile}`);
  const selected = sites.filter(site => (
    site.sourceFile === selector.sourceFile
    && (!selector.enclosingFunctions || selector.enclosingFunctions.includes(site.enclosingFunction))
    && (!selector.accessLanes || selector.accessLanes.includes(site.accessLane))
    && (!selector.authorityIds || selector.authorityIds.includes(site.authorityId))
  ));
  if (selector.enclosingFunctions) {
    for (const fn of selector.enclosingFunctions) {
      assert(
        selected.some(site => site.enclosingFunction === fn),
        `coverage selector matched no authority sites for missing symbol ${selector.sourceFile}#${fn}`,
      );
    }
  }
  if (selector.accessLanes) {
    for (const lane of selector.accessLanes) {
      assert(selected.some(site => site.accessLane === lane), `coverage selector matched no authority sites for access lane ${lane}`);
    }
  }
  if (selector.authorityIds) {
    for (const authorityId of selector.authorityIds) {
      assert(selected.some(site => site.authorityId === authorityId), `coverage selector matched no authority sites for authority ${authorityId}`);
    }
  }
  assert(selected.length > 0, `coverage selector matched no authority sites: ${selector.sourceFile}`);
  return selected;
}

function selectRawPublishers(selector, writers, assigned, authorityClassifications) {
  if (selector.inventoryRemainder === true) {
    return writers.filter(writer => (
      !assigned.has(rawPublisherIdentity(writer))
      && (!selector.authorityClassifications
        || selector.authorityClassifications.includes(
          authorityClassifications.get(writer.authorityId),
        ))
    ));
  }
  const absolute = resolve(repoRoot, selector.sourceFile);
  assert(existsSync(absolute), `raw publisher selector source is missing: ${selector.sourceFile}`);
  const selected = writers.filter(writer => (
    writer.sourceFile === selector.sourceFile
    && (!selector.enclosingFunctions
      || selector.enclosingFunctions.includes(writer.enclosingFunction))
    && (!selector.authorityIds || selector.authorityIds.includes(writer.authorityId))
  ));
  if (selector.enclosingFunctions) {
    for (const fn of selector.enclosingFunctions) {
      assert(
        selected.some(writer => writer.enclosingFunction === fn),
        `raw publisher selector matched no writer for missing symbol ${selector.sourceFile}#${fn}`,
      );
    }
  }
  if (selector.authorityIds) {
    for (const authorityId of selector.authorityIds) {
      assert(
        selected.some(writer => writer.authorityId === authorityId),
        `raw publisher selector matched no writer for authority ${authorityId}`,
      );
    }
  }
  assert(selected.length > 0, `raw publisher selector matched no writer: ${selector.sourceFile}`);
  return selected;
}

function validateAuthorityDisposition(entry, selected) {
  if (entry.id === 'projection') {
    for (const site of selected) {
      assert(
        site.classification === 'projection',
        `projection coverage cannot include ${siteIdentity(site)} (classification ${site.classification})`,
      );
    }
    return;
  }
  if (entry.disposition !== 'retained') return;
  for (const site of selected) {
    const violations = [];
    if (site.classification !== 'path_specific_authority') {
      violations.push(`classification ${site.classification}`);
    }
    if (retainedForbiddenAccessLanes.has(site.accessLane)) {
      violations.push(`access lane ${site.accessLane}`);
    }
    assert(
      violations.length === 0,
      `retained coverage ${entry.id} cannot include ${siteIdentity(site)} (${violations.join(', ')})`,
    );
  }
}

function validateRawPublisherDisposition(entry, selected, authorityClassifications) {
  if (entry.disposition !== 'retained') return;
  for (const writer of selected) {
    const classification = authorityClassifications.get(writer.authorityId);
    assert(
      classification === 'path_specific_authority',
      `retained raw publisher ${rawPublisherIdentity(writer)} cannot include classification ${classification ?? 'unknown'}`,
    );
  }
}

function sourceFile(path) {
  const cached = parsedSources.get(path);
  if (cached) return cached;
  const absolute = resolve(repoRoot, path);
  assert(existsSync(absolute), `production source is missing: ${path}`);
  const parsed = ts.createSourceFile(
    path,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  parsedSources.set(path, parsed);
  return parsed;
}

function declarationName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : undefined;
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
    return ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
  }
  return undefined;
}

function findNamedFunction(parsed, name) {
  const matches = [];
  const visit = node => {
    if (declarationName(node) === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert(matches.length === 1, `missing or ambiguous production symbol ${parsed.fileName}#${name}`);
  return matches[0];
}

function containsStringLiteral(node, expected) {
  let found = false;
  const visit = current => {
    if (ts.isStringLiteralLike(current) && current.text === expected) found = true;
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function calledName(call) {
  const render = expression => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) {
      const owner = render(expression.expression);
      return owner ? `${owner}.${expression.name.text}` : expression.name.text;
    }
    return undefined;
  };
  return render(call.expression);
}

function matchesForbiddenCall(actual, forbidden) {
  return actual === forbidden || actual.endsWith(`.${forbidden}`);
}

function callsWithin(node) {
  const calls = [];
  const visit = current => {
    if (ts.isCallExpression(current)) {
      const name = calledName(current);
      if (name) calls.push(name);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

function callExpressionsWithin(node, expected) {
  const calls = [];
  const visit = current => {
    if (ts.isCallExpression(current)) {
      const name = calledName(current);
      if (name && matchesForbiddenCall(name, expected)) calls.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

function importedModules(parsed) {
  return parsed.statements
    .filter(ts.isImportDeclaration)
    .map(statement => statement.moduleSpecifier)
    .filter(ts.isStringLiteralLike)
    .map(specifier => specifier.text);
}

function verifyNoForbiddenCalls(node, forbiddenCalls, label) {
  for (const actual of callsWithin(node)) {
    const forbidden = forbiddenCalls.find(candidate => matchesForbiddenCall(actual, candidate));
    assert(!forbidden, `${label} contains forbidden direct-write capability ${actual}`);
  }
}

function validateMigratedProductionBinding(binding, authoritySites) {
  const parsed = sourceFile(binding.sourceFile);
  const fn = findNamedFunction(parsed, binding.enclosingFunction);
  const candidates = [];
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const name = calledName(node);
      if (
        name && matchesForbiddenCall(name, binding.runtimeMethod)
        && containsStringLiteral(node, binding.commandKind)
      ) candidates.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  assert(
    candidates.length === 1,
    `production binding ${binding.sourceFile}#${binding.enclosingFunction} must contain exactly one ${binding.runtimeMethod} for ${binding.commandKind}`,
  );

  let scope = candidates[0].parent;
  while (scope && scope !== fn && !ts.isIfStatement(scope)) scope = scope.parent;
  assert(scope && ts.isIfStatement(scope), `production binding for ${binding.commandKind} lost its nearestIf scope`);
  verifyNoForbiddenCalls(scope, binding.forbiddenCalls, `migrated production branch ${binding.commandKind}`);

  for (const path of binding.pureRuntimeSources) {
    const runtimeSource = sourceFile(path);
    const directSites = authoritySites.filter(site => site.sourceFile === path);
    assert(directSites.length === 0, `migrated runtime core ${path} gained direct Session authority sites`);
    verifyNoForbiddenCalls(runtimeSource, binding.forbiddenCalls, `migrated runtime core ${path}`);
    const imports = importedModules(runtimeSource);
    for (const forbidden of binding.forbiddenImports) {
      assert(!imports.includes(forbidden), `migrated runtime core ${path} imports forbidden direct-write capability ${forbidden}`);
    }
  }
}

function validateExecutorProductionBinding(binding, authoritySites, assigned) {
  const worker = sourceFile(binding.workerSource);
  const handler = findNamedFunction(worker, binding.handlerFunction);
  const reservation = findNamedFunction(worker, binding.reservationFunction);
  assert(
    callExpressionsWithin(reservation, 'sessionExecutorRuntime.commitGeneration').length === 1,
    `executor reservation ${binding.workerSource}#${binding.reservationFunction} must delegate exactly once to commitGeneration`,
  );
  assert(
    authoritySites.every(site => !(
      site.sourceFile === binding.workerSource
      && site.enclosingFunction === binding.reservationFunction
    )),
    `executor reservation ${binding.workerSource}#${binding.reservationFunction} regained direct Session authority`,
  );
  assert(
    callExpressionsWithin(handler, 'sessionExecutorRuntime.activate').length === 1,
    `executor handler ${binding.workerSource}#${binding.handlerFunction} must activate exactly one opaque lease`,
  );
  assert(
    callExpressionsWithin(handler, 'sessionExecutorRuntime.isCurrent').length > 0,
    `executor handler ${binding.workerSource}#${binding.handlerFunction} must gate long-lived effects through isCurrent`,
  );
  assert(
    callExpressionsWithin(handler, 'sessionExecutorRuntime.resume').length > 0,
    `executor handler ${binding.workerSource}#${binding.handlerFunction} must revalidate async continuations`,
  );
  const reportCalls = callExpressionsWithin(handler, 'sessionExecutorRuntime.report');
  for (const kind of binding.observationKinds) {
    assert(
      reportCalls.some(call => containsStringLiteral(call, kind)),
      `executor handler ${binding.workerSource}#${binding.handlerFunction} does not report ${kind}`,
    );
  }
  assert(
    callExpressionsWithin(handler, 'createCurrentDispatchInputCommitEvidencePort').length === 1,
    `executor handler ${binding.workerSource}#${binding.handlerFunction} must bind one named input-commit evidence Adapter`,
  );
  assert(
    callExpressionsWithin(handler, 'recordDispatchInputCommit').length === 0,
    `executor handler ${binding.workerSource}#${binding.handlerFunction} bypasses the named input-commit evidence Adapter`,
  );

  const runtime = sourceFile(binding.runtimeSource);
  const runtimeSites = authoritySites.filter(site => site.sourceFile === binding.runtimeSource);
  assert(runtimeSites.length === 0, `executor Runtime core ${binding.runtimeSource} gained direct Session authority sites`);
  const forbiddenRuntimeImports = ['../services/session-store.js', './worker-pool.js'];
  const runtimeImports = importedModules(runtime);
  for (const forbidden of forbiddenRuntimeImports) {
    assert(
      !runtimeImports.includes(forbidden),
      `executor Runtime core ${binding.runtimeSource} imports forbidden Current capability ${forbidden}`,
    );
  }

  for (const adapterSource of [binding.currentAdapterSource, binding.evidenceAdapterSource]) {
    sourceFile(adapterSource);
    const adapterSites = authoritySites.filter(site => site.sourceFile === adapterSource);
    assert(adapterSites.length > 0, `executor Current Adapter ${adapterSource} has no reviewed authority evidence`);
    for (const site of adapterSites) {
      assert(
        site.accessLane === executorRuntimeAccessLane,
        `executor Current Adapter ${siteIdentity(site)} escaped the named access lane`,
      );
      assert(
        assigned.get(siteIdentity(site)) === 'executor-generation',
        `executor Current Adapter ${siteIdentity(site)} is not covered by the migrated A2 partition`,
      );
    }
  }
  for (const site of authoritySites.filter(site => site.accessLane === executorRuntimeAccessLane)) {
    assert(
      assigned.get(siteIdentity(site)) === 'executor-generation',
      `executor access-lane site ${siteIdentity(site)} is not covered by the migrated A2 partition`,
    );
  }
}

export function auditSessionRuntimeCoverage({ ledger } = {}) {
  const coverageLedger = ledger ?? JSON.parse(readFileSync(ledgerPath, 'utf8'));
  validateLedgerSchema(coverageLedger);
  const facts = loadFacts();
  const actualAuthorityDigest = sha256(facts.authorityRaw);
  assert(
    coverageLedger.authorityInventory.sha256 === actualAuthorityDigest,
    `authority inventory digest drifted: expected ${coverageLedger.authorityInventory.sha256}, actual ${actualAuthorityDigest}`,
  );

  const assigned = new Map();
  const entryCounts = [];
  for (const entry of coverageLedger.coverage) {
    const selected = [];
    for (const selector of entry.selectors) {
      for (const site of selectAuthoritySites(selector, facts.sites, assigned)) {
        const identity = siteIdentity(site);
        const previous = assigned.get(identity);
        assert(!previous, `coverage selector overlap: ${identity} is claimed by ${previous} and ${entry.id}`);
        assigned.set(identity, entry.id);
        selected.push(site);
      }
    }
    validateAuthorityDisposition(entry, selected);
    const actual = selectedSiteFacts(selected);
    assert(
      entry.authoritySites.recordCount === actual.recordCount
        && entry.authoritySites.mutationCount === actual.mutationCount
        && entry.authoritySites.digest === actual.digest,
      `${entry.id} authority site binding drifted: expected ${JSON.stringify(entry.authoritySites)}, actual ${JSON.stringify(actual)}`,
    );
    entryCounts.push(`${entry.id}=${actual.mutationCount}`);
  }

  assert(
    assigned.size === facts.sites.length,
    `SessionRuntime coverage is incomplete: assigned ${assigned.size} of ${facts.sites.length} authority records`,
  );

  const assignedRawPublishers = new Map();
  const rawFactsByEntry = new Map();
  for (const entry of coverageLedger.coverage) {
    if (!entry.rawPublisherSelectors) continue;
    const selected = [];
    for (const selector of entry.rawPublisherSelectors) {
      for (const writer of selectRawPublishers(
        selector,
        facts.rawPublishers,
        assignedRawPublishers,
        facts.authorityClassifications,
      )) {
        const identity = rawPublisherIdentity(writer);
        const previous = assignedRawPublishers.get(identity);
        assert(
          !previous,
          `raw publisher selector overlap: ${identity} is claimed by ${previous} and ${entry.id}`,
        );
        assignedRawPublishers.set(identity, entry.id);
        selected.push(writer);
      }
    }
    validateRawPublisherDisposition(entry, selected, facts.authorityClassifications);
    const actual = selectedRawPublisherFacts(selected);
    rawFactsByEntry.set(entry.id, actual);
  }
  assert(
    assignedRawPublishers.size === facts.rawPublishers.length,
    `raw Session publisher coverage is incomplete: assigned ${assignedRawPublishers.size} of ${facts.rawPublishers.length}`,
  );
  const currentStoreApply = facts.rawPublishers.find(writer => (
    writer.sourceFile === 'src/services/session-store.ts'
    && writer.enclosingFunction === 'apply'
    && writer.authorityId === 'current-session-row'
  ));
  assert(currentStoreApply, 'CurrentSessionStore raw publisher src/services/session-store.ts#apply is missing');
  assert(
    assignedRawPublishers.get(rawPublisherIdentity(currentStoreApply))
      === 'current-session-store-adapter',
    'CurrentSessionStore apply raw publisher must remain in the migrated A1 adapter, not retained',
  );
  for (const entry of coverageLedger.coverage) {
    const actual = rawFactsByEntry.get(entry.id);
    if (!actual) continue;
    assert(
      entry.authorityRawPublishers.recordCount === actual.recordCount
        && entry.authorityRawPublishers.publishSiteCount === actual.publishSiteCount
        && entry.authorityRawPublishers.digest === actual.digest,
      `${entry.id} raw publisher binding drifted: expected ${JSON.stringify(entry.authorityRawPublishers)}, actual ${JSON.stringify(actual)}`,
    );
  }
  const keyedTrigger = coverageLedger.coverage.find(entry => entry.id === 'keyed-trigger-start');
  validateMigratedProductionBinding(keyedTrigger.productionBinding, facts.sites);
  const executor = coverageLedger.coverage.find(entry => entry.id === 'executor-generation');
  validateExecutorProductionBinding(executor.productionBinding, facts.sites, assigned);
  return { summary: entryCounts.join(', ') };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = auditSessionRuntimeCoverage();
    console.log(`[session-runtime-coverage] verified: ${result.summary}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
