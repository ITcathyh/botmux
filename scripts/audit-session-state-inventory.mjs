#!/usr/bin/env node

/**
 * Freeze the current Session authority surface before the Actor Runtime moves it.
 *
 * The inventory is intentionally a census, not a claim that the current writers
 * are desirable. A new direct write must update the checked-in snapshot in the
 * same change, which makes bypass growth visible while A1/A2/A3 delete it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const inventoryPath = resolve(repoRoot, 'docs/architecture/session-authority-inventory.json');

const targetInterfaces = [
  { receiverKind: 'Session', sourceFile: 'src/types.ts', name: 'Session' },
  { receiverKind: 'DaemonSession', sourceFile: 'src/core/types.ts', name: 'DaemonSession' },
  { receiverKind: 'SessionData', sourceFile: 'src/cli.ts', name: 'SessionData' },
  {
    receiverKind: 'DispatchAcceptanceSession',
    sourceFile: 'src/core/dispatch.ts',
    name: 'DispatchAcceptanceSession',
  },
  {
    receiverKind: 'Session',
    sourceFile: 'src/core/vc-meeting-im-turn-origin.ts',
    name: 'VcMeetingImTurnOriginSession',
  },
];

const sessionStoreMutators = new Set([
  'createSession',
  'createSessionExact',
  'closeSession',
  'reactivateClosedSession',
  'updateSessionPid',
  'updateSession',
  'persistActiveRiffLineageExact',
  'persistActiveRiffLineagesExactBatch',
]);

const mutatingMethods = new Set([
  'add',
  'clear',
  'copyWithin',
  'delete',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

const assignmentOperators = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

const classifications = new Set([
  'session_owned_persisted',
  'path_specific_authority',
  'ephemeral_runtime',
  'projection',
]);

function slash(path) {
  return path.split(sep).join('/');
}

function sourcePath(sourceFile) {
  return slash(relative(repoRoot, sourceFile.fileName));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function propertyName(name, sourceFile) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sourceFile);
}

function enclosingSymbol(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      ts.isMethodDeclaration(current)
      || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current)
    ) {
      return propertyName(current.name, current.getSourceFile()) ?? '<method>';
    }
    if (ts.isConstructorDeclaration(current)) {
      const owner = current.parent;
      return ts.isClassLike(owner) && owner.name ? `${owner.name.text}.constructor` : 'constructor';
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) {
        return propertyName(parent.name, current.getSourceFile()) ?? '<callback>';
      }
    }
    current = current.parent;
  }
  return '<module>';
}

export function createSessionStateAuditProgram(extraRootNames = []) {
  const configPath = resolve(repoRoot, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(error => (
      ts.flattenDiagnosticMessageText(error.messageText, '\n')
    )).join('\n'));
  }
  return ts.createProgram({
    rootNames: [...parsed.fileNames, ...extraRootNames.map(path => resolve(repoRoot, path))],
    options: { ...parsed.options, noEmit: true },
  });
}

function buildTargetLookup() {
  return new Map(targetInterfaces.map(target => [
    `${resolve(repoRoot, target.sourceFile)}\0${target.name}`,
    target,
  ]));
}

function targetForDeclaration(declaration, targetLookup) {
  const parent = declaration?.parent;
  if (!parent || !ts.isInterfaceDeclaration(parent)) return undefined;
  return targetLookup.get(`${resolve(parent.getSourceFile().fileName)}\0${parent.name.text}`);
}

function targetForSymbol(symbol, targetLookup) {
  for (const declaration of symbol?.declarations ?? []) {
    const target = targetForDeclaration(declaration, targetLookup);
    if (target) return target;
  }
  return undefined;
}

function targetForType(type, targetLookup) {
  if (type.isUnionOrIntersection()) {
    for (const member of type.types) {
      const target = targetForType(member, targetLookup);
      if (target) return target;
    }
  }
  const symbol = type.aliasSymbol ?? type.symbol;
  for (const declaration of symbol?.declarations ?? []) {
    if (!ts.isInterfaceDeclaration(declaration)) continue;
    const target = targetLookup.get(
      `${resolve(declaration.getSourceFile().fileName)}\0${declaration.name.text}`,
    );
    if (target) return target;
  }
  return undefined;
}

function domainField(expression, checker, targetLookup, aliases = new Map()) {
  if (ts.isIdentifier(expression)) {
    const alias = aliases.get(checker.getSymbolAtLocation(expression));
    return alias?.kind === 'field'
      && expression.pos >= alias.validFrom && expression.pos < alias.validUntil
      ? alias.origin
      : undefined;
  }
  if (ts.isParenthesizedExpression(expression)
      || ts.isNonNullExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)) {
    return domainField(expression.expression, checker, targetLookup, aliases);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const target = targetForSymbol(checker.getSymbolAtLocation(expression.name), targetLookup);
    if (target) return { target, fieldPath: expression.name.text };
    return domainField(expression.expression, checker, targetLookup, aliases);
  }
  if (ts.isElementAccessExpression(expression)) {
    const receiverType = checker.getTypeAtLocation(expression.expression);
    const target = targetForType(receiverType, targetLookup);
    if (
      target && expression.argumentExpression
      && (ts.isStringLiteralLike(expression.argumentExpression)
        || ts.isNumericLiteral(expression.argumentExpression))
    ) {
      const fieldPath = expression.argumentExpression.text;
      const field = checker.getPropertyOfType(receiverType, fieldPath);
      if (field && targetForSymbol(field, targetLookup)) return { target, fieldPath };
    }
    if (target) return { target, fieldPath: '*' };
    return domainField(expression.expression, checker, targetLookup, aliases);
  }
  if (
    ts.isBinaryExpression(expression)
    && (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return domainField(expression.left, checker, targetLookup, aliases)
      ?? domainField(expression.right, checker, targetLookup, aliases);
  }
  if (
    ts.isBinaryExpression(expression)
    && (
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken
      || expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    )
  ) return domainField(expression.left, checker, targetLookup, aliases);
  if (
    ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return domainField(expression.right, checker, targetLookup, aliases)
      ?? domainField(expression.left, checker, targetLookup, aliases);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return domainField(expression.right, checker, targetLookup, aliases);
  }
  if (ts.isConditionalExpression(expression)) {
    return domainField(expression.whenTrue, checker, targetLookup, aliases)
      ?? domainField(expression.whenFalse, checker, targetLookup, aliases);
  }
  // A call, array/object literal, or other derived value is a copy/result. Do not
  // search its callbacks or operands merely because they mention a Session field.
  return undefined;
}

const shallowElementPreservingMethods = new Set([
  'concat',
  'filter',
  'reverse',
  'slice',
  'sort',
  'toReversed',
  'toSorted',
  'with',
]);

function containerElementOrigin(expression, checker, targetLookup, aliases) {
  const direct = domainField(expression, checker, targetLookup, aliases);
  if (direct) return direct;
  if (ts.isIdentifier(expression)) {
    const alias = aliases.get(checker.getSymbolAtLocation(expression));
    if (
      alias?.kind === 'shallow_container'
      && expression.pos >= alias.validFrom
      && expression.pos < alias.validUntil
    ) return alias.origin;
  }
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
  ) return containerElementOrigin(expression.expression, checker, targetLookup, aliases);
  if (ts.isArrayLiteralExpression(expression)) {
    for (const element of expression.elements) {
      if (!ts.isSpreadElement(element)) continue;
      const origin = containerElementOrigin(element.expression, checker, targetLookup, aliases);
      if (origin) return origin;
    }
    return undefined;
  }
  if (ts.isConditionalExpression(expression)) {
    return containerElementOrigin(expression.whenTrue, checker, targetLookup, aliases)
      ?? containerElementOrigin(expression.whenFalse, checker, targetLookup, aliases);
  }
  if (
    ts.isBinaryExpression(expression)
    && (
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    )
  ) {
    return containerElementOrigin(expression.right, checker, targetLookup, aliases)
      ?? containerElementOrigin(expression.left, checker, targetLookup, aliases);
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    const method = expression.expression.name.text;
    if (shallowElementPreservingMethods.has(method)) {
      return containerElementOrigin(expression.expression.expression, checker, targetLookup, aliases);
    }
    if (
      ts.isIdentifier(expression.expression.expression)
      && expression.expression.expression.text === 'Array'
      && method === 'from'
      && expression.arguments[0]
    ) return containerElementOrigin(expression.arguments[0], checker, targetLookup, aliases);
  }
  return undefined;
}

function referencedElementOrigin(expression, checker, targetLookup, aliases) {
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
  ) return referencedElementOrigin(expression.expression, checker, targetLookup, aliases);
  if (ts.isElementAccessExpression(expression)) {
    return containerElementOrigin(expression.expression, checker, targetLookup, aliases);
  }
  if (ts.isConditionalExpression(expression)) {
    return referencedElementOrigin(expression.whenTrue, checker, targetLookup, aliases)
      ?? referencedElementOrigin(expression.whenFalse, checker, targetLookup, aliases);
  }
  if (
    ts.isBinaryExpression(expression)
    && (
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    )
  ) {
    return referencedElementOrigin(expression.right, checker, targetLookup, aliases)
      ?? referencedElementOrigin(expression.left, checker, targetLookup, aliases);
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    if (['at', 'find', 'findLast', 'pop', 'shift'].includes(expression.expression.name.text)) {
      return containerElementOrigin(expression.expression.expression, checker, targetLookup, aliases);
    }
  }
  return undefined;
}

function buildDomainAliases(sourceFile, checker, targetLookup) {
  const aliases = new Map();
  const candidates = [];
  const reassignments = new Map();

  const addReassignment = identifier => {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol) return;
    const positions = reassignments.get(symbol) ?? [];
    positions.push(identifier.pos);
    reassignments.set(symbol, positions);
  };

  const addBindingCandidates = (name, declaration, initializer, directTarget) => {
    if (ts.isIdentifier(name)) {
      candidates.push({ name, declaration, initializer, directTarget });
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element) || element.dotDotDotToken) continue;
      if (!ts.isBindingElement(element)) continue;
      let elementTarget = directTarget;
      if (directTarget && ts.isObjectBindingPattern(name)) {
        if (directTarget.target) {
          elementTarget = directTarget;
        } else {
          const fieldPath = propertyName(element.propertyName ?? element.name, sourceFile);
          const receiverType = checker.getTypeAtLocation(initializer);
          const field = fieldPath ? checker.getPropertyOfType(receiverType, fieldPath) : undefined;
          elementTarget = field && targetForSymbol(field, targetLookup)
            ? { target: directTarget, fieldPath }
            : undefined;
        }
      }
      addBindingCandidates(element.name, declaration, initializer, elementTarget);
    }
  };

  const visit = node => {
    if (
      ts.isVariableDeclaration(node)
      && node.initializer
      && ts.isVariableDeclarationList(node.parent)
    ) {
      const directTarget = targetForType(checker.getTypeAtLocation(node.initializer), targetLookup);
      addBindingCandidates(node.name, node, node.initializer, directTarget);
    }
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) {
        addBindingCandidates(declaration.name, declaration, node.expression, undefined);
      }
    }
    if (ts.isBinaryExpression(node) && assignmentOperators.has(node.operatorToken.kind)) {
      if (ts.isIdentifier(node.left)) addReassignment(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && ts.isIdentifier(node.operand)
    ) addReassignment(node.operand);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      const symbol = checker.getSymbolAtLocation(candidate.name);
      if (!symbol || aliases.has(symbol)) continue;
      // Whole Session/DaemonSession aliases are resolved by their member symbols;
      // only nested field aliases need an origin entry.
      if (ts.isIdentifier(candidate.declaration.name) && candidate.directTarget) continue;
      const fieldOrigin = candidate.directTarget
        ?? domainField(candidate.initializer, checker, targetLookup, aliases)
        ?? referencedElementOrigin(candidate.initializer, checker, targetLookup, aliases);
      const origin = fieldOrigin
        ?? containerElementOrigin(candidate.initializer, checker, targetLookup, aliases);
      if (!origin) continue;
      const validFrom = candidate.declaration.end;
      const validUntil = Math.min(
        ...(reassignments.get(symbol) ?? []).filter(position => position >= validFrom),
        Number.POSITIVE_INFINITY,
      );
      aliases.set(symbol, {
        kind: fieldOrigin ? 'field' : 'shallow_container',
        origin,
        validFrom,
        validUntil,
      });
      changed = true;
    }
  }
  return aliases;
}

function mutationOperation(node) {
  if (ts.isBinaryExpression(node) && assignmentOperators.has(node.operatorToken.kind)) {
    return {
      target: node.left,
      operation: node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? 'assign' : 'compound_assign',
    };
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return { target: node.operand, operation: 'increment' };
  }
  if (ts.isDeleteExpression(node)) return { target: node.expression, operation: 'delete' };
  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && mutatingMethods.has(node.expression.name.text)
  ) {
    return { target: node.expression.expression, operation: `mutate:${node.expression.name.text}` };
  }
  return undefined;
}

function objectAssignTargets(node, checker, targetLookup, aliases) {
  if (
    !ts.isCallExpression(node)
    || !ts.isPropertyAccessExpression(node.expression)
    || !ts.isIdentifier(node.expression.expression)
    || node.expression.expression.text !== 'Object'
    || node.expression.name.text !== 'assign'
    || node.arguments.length < 2
  ) return [];

  const destination = node.arguments[0];
  const nested = domainField(destination, checker, targetLookup, aliases);
  if (nested) return [{ ...nested, operation: 'object_assign' }];
  const destinationType = checker.getTypeAtLocation(destination);
  const target = targetForType(destinationType, targetLookup);
  if (!target) return [];

  const fields = new Set();
  for (const source of node.arguments.slice(1)) {
    if (!ts.isObjectLiteralExpression(source)) {
      fields.add('*');
      continue;
    }
    for (const property of source.properties) {
      if (ts.isSpreadAssignment(property)) {
        fields.add('*');
        continue;
      }
      const name = propertyName(property.name, source.getSourceFile());
      if (name) fields.add(name);
    }
  }
  return [...fields].sort(compareText).map(fieldPath => ({ target, fieldPath, operation: 'object_assign' }));
}

function importBindings(sourceFile, moduleSuffix) {
  const namespaces = new Set();
  const named = new Map();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.endsWith(moduleSuffix)
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      named.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  return { namespaces, named };
}

function importedCallName(node, bindings) {
  if (!ts.isCallExpression(node)) return undefined;
  const expression = node.expression;
  if (
    ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && bindings.namespaces.has(expression.expression.text)
  ) return expression.name.text;
  if (ts.isIdentifier(expression)) return bindings.named.get(expression.text);
  return undefined;
}

function importedObjectMethodName(node, bindings, importedName) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const receiver = node.expression.expression;
  if (!ts.isIdentifier(receiver) || bindings.named.get(receiver.text) !== importedName) return undefined;
  return node.expression.name.text;
}

function isDaemonSessionType(type, targetLookup) {
  if (type.isUnionOrIntersection()) return type.types.some(member => isDaemonSessionType(member, targetLookup));
  return targetForType(type, targetLookup)?.receiverKind === 'DaemonSession';
}

function isMapOfDaemonSessions(type, checker, targetLookup) {
  if (type.isUnion()) return type.types.some(member => isMapOfDaemonSessions(member, checker, targetLookup));
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  if (!(type.objectFlags & ts.ObjectFlags.Reference)) return false;
  const reference = type;
  const symbol = reference.target?.aliasSymbol ?? reference.target?.symbol;
  if (symbol?.getName() !== 'Map') return false;
  const args = checker.getTypeArguments(reference);
  return !!args[1] && isDaemonSessionType(args[1], targetLookup);
}

function classificationFor(receiverKind, fieldPath = '*') {
  if (receiverKind === 'DaemonSession' || receiverKind === 'DaemonSessionMap') {
    return { classification: 'ephemeral_runtime', authorityId: 'actor-host-runtime' };
  }
  if (receiverKind === 'DashboardProjection') {
    return { classification: 'projection', authorityId: 'dashboard-projection' };
  }
  if (receiverKind === 'DispatchAcceptanceSession' || fieldPath === 'dispatchInputReceipts') {
    return { classification: 'path_specific_authority', authorityId: 'dispatch-card-and-turn-evidence' };
  }
  if (
    fieldPath === 'pendingRepoSetup'
    || fieldPath === 'initialUserTurnPending'
    || fieldPath.startsWith('queuedActivation')
  ) {
    return { classification: 'path_specific_authority', authorityId: 'pending-repo-and-activation' };
  }
  if (fieldPath === 'codexAppDispatchLedger' || fieldPath === 'codexAppGenerationCommits') {
    return { classification: 'path_specific_authority', authorityId: 'codex-app-dispatch-control' };
  }
  if (fieldPath === 'riffParentTaskId' || fieldPath === 'riffRepoDirs') {
    return { classification: 'path_specific_authority', authorityId: 'riff-lineage' };
  }
  if (fieldPath === 'docCommentTargets') {
    return { classification: 'path_specific_authority', authorityId: 'doc-comment-turn-target' };
  }
  if (
    fieldPath === 'replyTargets'
    || fieldPath === 'replyTargetsPrunedThrough'
    || fieldPath === 'turnReplyContexts'
  ) {
    return { classification: 'path_specific_authority', authorityId: 'dispatch-card-and-turn-evidence' };
  }
  if (fieldPath === 'vcMeetingImTurnOrigins') {
    return { classification: 'path_specific_authority', authorityId: 'vc-action-and-delivery' };
  }
  if (receiverKind === 'SessionData') {
    return { classification: 'session_owned_persisted', authorityId: 'offline-session-mutation' };
  }
  return { classification: 'session_owned_persisted', authorityId: 'current-session-row' };
}

function accessLaneFor(receiverKind, path, operation) {
  if (path === 'src/core/current-scheduled-fire.ts') {
    return 'session-runtime-scheduled-adapter';
  }
  if (receiverKind === 'DaemonSession') return 'actor-host-direct';
  if (receiverKind === 'DaemonSessionMap') {
    return path === 'src/core/riff-shutdown-detach.ts'
      ? 'shutdown-session-snapshot'
      : 'active-registry-direct';
  }
  if (receiverKind === 'SessionData') return 'offline-cli-direct';
  if (receiverKind === 'DispatchAcceptanceSession') return 'dispatch-receipt-helper';
  if (receiverKind === 'DashboardProjection') return 'dashboard-event-publish';
  if (receiverKind === 'SessionStore') {
    return operation.includes('RiffLineage') ? 'riff-lineage-adapter' : 'session-store-api';
  }
  if (path === 'src/services/session-store.ts') return 'current-session-store-internal';
  if (path === 'src/core/pending-repo-journal.ts') return 'pending-repo-adapter';
  if (path === 'src/core/vc-meeting-im-turn-origin.ts') {
    return 'current-vc-meeting-im-turn-origin-adapter';
  }
  return 'direct-caller-mutation';
}

function addGrouped(groups, site) {
  const identity = JSON.stringify([
    site.sourceFile,
    site.enclosingFunction,
    site.receiverKind,
    site.fieldPath,
    site.operation,
    site.normalizedAstHash,
    site.classification,
    site.authorityId,
    site.accessLane,
  ]);
  const existing = groups.get(identity);
  if (existing) existing.count += 1;
  else groups.set(identity, { ...site, count: 1 });
}

function normalizedText(node) {
  return node.getText(node.getSourceFile()).replace(/\s+/g, ' ').trim();
}

function controlHeader(node) {
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    return `${ts.SyntaxKind[node.kind]}:${normalizedText(node.expression)}`;
  }
  if (ts.isForStatement(node)) {
    return `ForStatement:${node.initializer ? normalizedText(node.initializer) : ''};`
      + `${node.condition ? normalizedText(node.condition) : ''};`
      + `${node.incrementor ? normalizedText(node.incrementor) : ''}`;
  }
  if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    return `${ts.SyntaxKind[node.kind]}:${normalizedText(node.initializer)}:${normalizedText(node.expression)}`;
  }
  if (ts.isSwitchStatement(node)) return `SwitchStatement:${normalizedText(node.expression)}`;
  if (ts.isCaseClause(node)) return `CaseClause:${normalizedText(node.expression)}`;
  if (ts.isDefaultClause(node)) return 'DefaultClause';
  if (ts.isCatchClause(node)) return `CatchClause:${node.variableDeclaration?.name.getText() ?? ''}`;
  return undefined;
}

function normalizedAstHash(node) {
  const parts = [normalizedText(node)];
  let current = node.parent;
  while (current && parts.length < 4) {
    const header = controlHeader(current);
    if (header) parts.push(header);
    if (ts.isFunctionLike(current)) break;
    current = current.parent;
  }
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

function dashboardEventType(node) {
  const value = node.arguments[0];
  if (!value || !ts.isObjectLiteralExpression(value)) return '*';
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property.name, property.getSourceFile()) !== 'type') continue;
    return ts.isStringLiteralLike(property.initializer) ? property.initializer.text : '*';
  }
  return '*';
}

export function collectSessionStateInventory({
  extraRootNames = [],
  includeSourcePaths,
  program = createSessionStateAuditProgram(extraRootNames),
} = {}) {
  const checker = program.getTypeChecker();
  const targetLookup = buildTargetLookup();
  const groups = new Map();

  for (const sourceFile of program.getSourceFiles()) {
    const path = sourcePath(sourceFile);
    if (includeSourcePaths ? !includeSourcePaths.includes(path) : !path.startsWith('src/')) continue;
    const aliases = buildDomainAliases(sourceFile, checker, targetLookup);
    const sessionStoreBindings = importBindings(sourceFile, 'services/session-store.js');
    const dashboardBindings = importBindings(sourceFile, 'core/dashboard-events.js');
    // Most core callers use `./dashboard-events.js`, which lacks the `core/` prefix.
    const localDashboardBindings = importBindings(sourceFile, 'dashboard-events.js');
    for (const value of localDashboardBindings.namespaces) dashboardBindings.namespaces.add(value);
    for (const [local, imported] of localDashboardBindings.named) dashboardBindings.named.set(local, imported);

    const visit = node => {
      const mutation = mutationOperation(node);
      if (mutation) {
        const field = domainField(mutation.target, checker, targetLookup, aliases);
        if (field) {
          const base = classificationFor(field.target.receiverKind, field.fieldPath);
          addGrouped(groups, {
            sourceFile: path,
            enclosingFunction: enclosingSymbol(node),
            receiverKind: field.target.receiverKind,
            fieldPath: field.fieldPath,
            operation: mutation.operation,
            normalizedAstHash: normalizedAstHash(node),
            ...base,
            accessLane: accessLaneFor(field.target.receiverKind, path, mutation.operation),
          });
        }
      }

      for (const assigned of objectAssignTargets(node, checker, targetLookup, aliases)) {
        const base = classificationFor(assigned.target.receiverKind, assigned.fieldPath);
        addGrouped(groups, {
          sourceFile: path,
          enclosingFunction: enclosingSymbol(node),
          receiverKind: assigned.target.receiverKind,
          fieldPath: assigned.fieldPath,
          operation: assigned.operation,
          normalizedAstHash: normalizedAstHash(node),
          ...base,
          accessLane: accessLaneFor(assigned.target.receiverKind, path, assigned.operation),
        });
      }

      const storeCall = importedCallName(node, sessionStoreBindings);
      if (storeCall && sessionStoreMutators.has(storeCall)) {
        const riffLineage = storeCall.includes('RiffLineage');
        const authorityId = riffLineage ? 'riff-lineage' : 'current-session-row';
        addGrouped(groups, {
          sourceFile: path,
          enclosingFunction: enclosingSymbol(node),
          receiverKind: 'SessionStore',
          fieldPath: '*',
          operation: `call:${storeCall}`,
          normalizedAstHash: normalizedAstHash(node),
          classification: riffLineage ? 'path_specific_authority' : 'session_owned_persisted',
          authorityId,
          accessLane: accessLaneFor('SessionStore', path, storeCall),
        });
      }

      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ['set', 'delete', 'clear'].includes(node.expression.name.text)
        && isMapOfDaemonSessions(checker.getTypeAtLocation(node.expression.expression), checker, targetLookup)
      ) {
        addGrouped(groups, {
          sourceFile: path,
          enclosingFunction: enclosingSymbol(node),
          receiverKind: 'DaemonSessionMap',
          fieldPath: '*',
          operation: `mutate:${node.expression.name.text}`,
          normalizedAstHash: normalizedAstHash(node),
          classification: 'ephemeral_runtime',
          authorityId: path === 'src/core/riff-shutdown-detach.ts'
            ? 'actor-host-runtime'
            : 'active-session-registry',
          accessLane: accessLaneFor('DaemonSessionMap', path, node.expression.name.text),
        });
      }

      const dashboardCall = importedObjectMethodName(node, dashboardBindings, 'dashboardEventBus');
      if (dashboardCall === 'publish') {
        addGrouped(groups, {
          sourceFile: path,
          enclosingFunction: enclosingSymbol(node),
          receiverKind: 'DashboardProjection',
          fieldPath: dashboardEventType(node),
          operation: 'publish',
          normalizedAstHash: normalizedAstHash(node),
          classification: 'projection',
          authorityId: 'dashboard-projection',
          accessLane: 'dashboard-event-publish',
        });
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return [...groups.values()].sort((left, right) => compareText(
    JSON.stringify(left),
    JSON.stringify(right),
  ));
}

const rawPublishPrimitives = new Set([
  'atomicWriteFile',
  'atomicWriteFileSync',
  'rename',
  'renameSync',
  'writeFile',
  'writeFileSync',
]);

function rawPrimitiveName(expression, checker, seenSymbols = new Set()) {
  if (ts.isPropertyAccessExpression(expression)) {
    return rawPublishPrimitives.has(expression.name.text) ? expression.name.text : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  if (rawPublishPrimitives.has(expression.text)) return expression.text;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isImportSpecifier(declaration)) {
      const imported = (declaration.propertyName ?? declaration.name).text;
      if (rawPublishPrimitives.has(imported)) return imported;
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const aliased = rawPrimitiveName(declaration.initializer, checker, seenSymbols);
      if (aliased) return aliased;
    }
  }
  return undefined;
}

function rawPublishPrimitive(node, checker) {
  if (!ts.isCallExpression(node)) return undefined;
  return rawPrimitiveName(node.expression, checker);
}

function namedFunctionLike(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current;
    if (
      ts.isMethodDeclaration(current)
      || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current)
      || ts.isConstructorDeclaration(current)
    ) return current;
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return current;
      if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) return current;
    }
    current = current.parent;
  }
  return undefined;
}

function hasSessionPathMarker(text) {
  return /sessions(?:-|\.json|'|")/.test(text);
}

function sessionPathLikeName(text) {
  return /(?:session.*(?:file|path)|(?:file|path).*session)/i.test(text);
}

function expressionHasSessionPath(expression, checker, seenSymbols = new Set()) {
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
  ) return expressionHasSessionPath(expression.expression, checker, seenSymbols);
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return hasSessionPathMarker(expression.text);
  }
  if (ts.isTemplateExpression(expression)) {
    if (hasSessionPathMarker(expression.head.text)) return true;
    return expression.templateSpans.some(span => (
      hasSessionPathMarker(span.literal.text)
      || expressionHasSessionPath(span.expression, checker, seenSymbols)
    ));
  }
  if (ts.isIdentifier(expression)) {
    if (sessionPathLikeName(expression.text)) return true;
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || seenSymbols.has(symbol)) return false;
    seenSymbols.add(symbol);
    return (symbol.declarations ?? []).some(declaration => (
      (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration))
      && !!declaration.initializer
      && expressionHasSessionPath(declaration.initializer, checker, seenSymbols)
    ));
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return sessionPathLikeName(expression.name.text)
      || expressionHasSessionPath(expression.expression, checker, seenSymbols);
  }
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
    const callee = expression.expression;
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    if (sessionPathLikeName(calleeName)) return true;
    const symbol = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(callee) ? callee.name : callee,
    );
    if (symbol && !seenSymbols.has(symbol)) {
      seenSymbols.add(symbol);
      if ((symbol.declarations ?? []).some(declaration => hasSessionPathMarker(normalizedText(declaration)))) {
        return true;
      }
    }
    return (expression.arguments ?? []).some(argument => (
      expressionHasSessionPath(argument, checker, new Set(seenSymbols))
    ));
  }
  if (ts.isBinaryExpression(expression)) {
    return expressionHasSessionPath(expression.left, checker, new Set(seenSymbols))
      || expressionHasSessionPath(expression.right, checker, new Set(seenSymbols));
  }
  if (ts.isConditionalExpression(expression)) {
    return expressionHasSessionPath(expression.whenTrue, checker, new Set(seenSymbols))
      || expressionHasSessionPath(expression.whenFalse, checker, new Set(seenSymbols));
  }
  return false;
}

function looksLikeSessionFilePublisher(path, fn, node, primitive, checker) {
  if (path === 'src/services/session-store.ts') return true;
  const text = fn ? normalizedText(fn) : '';
  if (hasSessionPathMarker(text)) return true;
  const pathArguments = primitive === 'rename' || primitive === 'renameSync'
    ? node.arguments.slice(0, 2)
    : node.arguments.slice(0, 1);
  return pathArguments.some(argument => expressionHasSessionPath(argument, checker));
}

export function collectRawSessionFileWriters({
  extraRootNames = [],
  includeSourcePaths,
  program = createSessionStateAuditProgram(extraRootNames),
} = {}) {
  // Binding initializes parent links used to resolve the named outer function
  // around nested file-lock callbacks.
  const checker = program.getTypeChecker();
  const candidates = new Map();
  for (const sourceFile of program.getSourceFiles()) {
    const path = sourcePath(sourceFile);
    if (includeSourcePaths ? !includeSourcePaths.includes(path) : !path.startsWith('src/')) continue;
    const visit = node => {
      const primitive = rawPublishPrimitive(node, checker);
      if (primitive) {
        const fn = namedFunctionLike(node);
        if (looksLikeSessionFilePublisher(path, fn, node, primitive, checker)) {
          const key = `${path}#${enclosingSymbol(node)}`;
          const candidate = candidates.get(key) ?? {
            sourceFile: path,
            enclosingFunction: enclosingSymbol(node),
            functionDigest: createHash('sha256')
              .update(fn ? normalizedText(fn) : '<module>')
              .digest('hex').slice(0, 16),
            sites: [],
          };
          candidate.sites.push(`${primitive}:${normalizedAstHash(node)}`);
          candidates.set(key, candidate);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...candidates.values()].map(candidate => ({
    sourceFile: candidate.sourceFile,
    enclosingFunction: candidate.enclosingFunction,
    siteCount: candidate.sites.length,
    siteDigest: createHash('sha256').update(candidate.sites.sort(compareText).join('\0'))
      .digest('hex').slice(0, 16),
    functionDigest: candidate.functionDigest,
  })).sort((left, right) => compareText(
    `${left.sourceFile}#${left.enclosingFunction}`,
    `${right.sourceFile}#${right.enclosingFunction}`,
  ));
}

export function collectDeclaredFunctionDigests(program) {
  program.getTypeChecker();
  const symbols = new Map();
  for (const sourceFile of program.getSourceFiles()) {
    const path = sourcePath(sourceFile);
    if (!path.startsWith('src/')) continue;
    const visit = node => {
      if (
        (ts.isFunctionDeclaration(node) && node.name)
        || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node)
      ) {
        symbols.set(
          `${path}#${enclosingSymbol(node.name ?? node)}`,
          createHash('sha256').update(normalizedText(node)).digest('hex').slice(0, 16),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return symbols;
}

function validateManualInventory(inventory, program) {
  if (inventory.schemaVersion !== 2) throw new Error('unsupported session authority inventory schema');
  if (!Array.isArray(inventory.authorities) || !Array.isArray(inventory.oracles)) {
    throw new Error('inventory must declare authorities and oracles');
  }
  const expectedCanonical = targetInterfaces.slice(0, 2)
    .map(target => `${target.sourceFile}#${target.name}`);
  const expectedStructural = targetInterfaces.slice(2)
    .map(target => `${target.sourceFile}#${target.name}`);
  if (JSON.stringify(inventory.scanner?.canonicalSymbols) !== JSON.stringify(expectedCanonical)) {
    throw new Error('canonical Session scanner symbols drifted from the inventory');
  }
  if (JSON.stringify(inventory.scanner?.structuralWriterTypes) !== JSON.stringify(expectedStructural)) {
    throw new Error('structural Session writer types drifted from the inventory');
  }
  const authorityIds = new Set();
  for (const authority of inventory.authorities) {
    if (!authority.id || authorityIds.has(authority.id)) {
      throw new Error(`duplicate or empty authority id: ${authority.id ?? '(empty)'}`);
    }
    if (!classifications.has(authority.classification)) {
      throw new Error(`invalid authority classification for ${authority.id}`);
    }
    authorityIds.add(authority.id);
  }
  const expectedRawWriters = inventory.scanner?.rawSessionFileWriters ?? [];
  for (const writer of expectedRawWriters) {
    const path = resolve(repoRoot, writer.sourceFile);
    if (!existsSync(path)) throw new Error(`raw Session writer is missing: ${writer.sourceFile}`);
    if (!authorityIds.has(writer.authorityId)) {
      throw new Error(`raw Session writer has unknown authority: ${writer.authorityId}`);
    }
  }
  const rawIdentity = writer => `${writer.sourceFile}#${writer.enclosingFunction}`
    + ` :: ${writer.siteCount} :: ${writer.siteDigest} :: ${writer.functionDigest}`;
  const expectedRawKeys = expectedRawWriters.map(rawIdentity)
    .sort(compareText);
  const rawExclusions = inventory.scanner?.rawSessionFileWriterExclusions ?? [];
  for (const exclusion of rawExclusions) {
    if (!authorityIds.has(exclusion.authorityId) || !exclusion.reason) {
      throw new Error(`raw writer exclusion needs a known authority and reason: ${exclusion.sourceFile}#${exclusion.enclosingFunction}`);
    }
  }
  const excludedRawKeys = rawExclusions
    .map(rawIdentity).sort(compareText);
  const rawBaseIdentity = writer => `${writer.sourceFile}#${writer.enclosingFunction}`;
  const excludedRawBases = new Set(rawExclusions.map(rawBaseIdentity));
  const overlap = expectedRawWriters.map(rawBaseIdentity).filter(key => excludedRawBases.has(key));
  if (overlap.length > 0) throw new Error(`raw Session publishers cannot also be exclusions: ${overlap.join(', ')}`);
  const classifiedRawKeys = [...expectedRawKeys, ...excludedRawKeys].sort(compareText);
  const actualRawKeys = collectRawSessionFileWriters({ program })
    .map(rawIdentity);
  if (JSON.stringify(classifiedRawKeys) !== JSON.stringify(actualRawKeys)) {
    throw new Error(`raw Session file publishers drifted:\n${mismatchMessage(
      Object.fromEntries(classifiedRawKeys.map(key => [key, 1])),
      Object.fromEntries(actualRawKeys.map(key => [key, 1])),
    )}`);
  }
  const knownSymbols = collectDeclaredFunctionDigests(program);
  for (const writer of inventory.scanner?.structuralRecordWriters ?? []) {
    const key = `${writer.sourceFile}#${writer.enclosingFunction}`;
    const bodyDigest = knownSymbols.get(key);
    if (!bodyDigest) throw new Error(`structural Session writer is missing: ${key}`);
    if (writer.bodyDigest !== bodyDigest) {
      throw new Error(`structural Session writer body drifted: ${key}`);
    }
    if (!authorityIds.has(writer.authorityId)) {
      throw new Error(`structural Session writer has unknown authority: ${writer.authorityId}`);
    }
  }
  for (const oracle of inventory.oracles) {
    if (!oracle.scenario || !Array.isArray(oracle.tests) || oracle.tests.length === 0) {
      throw new Error('every Session oracle needs a scenario and at least one test');
    }
    for (const test of oracle.tests) {
      if (!existsSync(resolve(repoRoot, test))) throw new Error(`Session oracle is missing: ${test}`);
    }
  }
  return new Map(inventory.authorities.map(authority => [authority.id, authority.classification]));
}

function siteIdentity(site) {
  return `${site.sourceFile}#${site.enclosingFunction}`
    + ` :: ${site.receiverKind}.${site.fieldPath}`
    + ` :: ${site.operation}`
    + ` :: ${site.normalizedAstHash}`;
}

export function suggestedSiteRecord(site) {
  return {
    sourceFile: site.sourceFile,
    enclosingFunction: site.enclosingFunction,
    receiverKind: site.receiverKind,
    fieldPath: site.fieldPath,
    operation: site.operation,
    normalizedAstHash: site.normalizedAstHash,
    count: site.count,
    classification: site.classification,
    authorityId: site.authorityId,
    accessLane: site.accessLane,
  };
}

function mechanicalSnapshot(sites) {
  return Object.fromEntries([...sites]
    .sort((left, right) => compareText(siteIdentity(left), siteIdentity(right)))
    .map(site => [siteIdentity(site), site.count]));
}

function validateMutationAnnotations(records, authorityClasses) {
  if (!Array.isArray(records)) throw new Error('mutationSites must be an array of reviewed records');
  const identities = new Set();
  for (const site of records) {
    const identity = siteIdentity(site);
    if (identities.has(identity)) throw new Error(`duplicate Session mutation site: ${identity}`);
    identities.add(identity);
    if (!classifications.has(site.classification)) {
      throw new Error(`unclassified Session mutation: ${identity}`);
    }
    const authorityClass = authorityClasses.get(site.authorityId);
    if (!authorityClass) throw new Error(`Session mutation has unknown authority: ${identity}`);
    if (authorityClass !== site.classification) {
      throw new Error(`Session mutation classification disagrees with authority ${site.authorityId}: ${identity}`);
    }
    if (typeof site.accessLane !== 'string' || site.accessLane.length === 0) {
      throw new Error(`Session mutation is missing its access lane: ${identity}`);
    }
  }
}

export function mergeReviewedMutationSites(actual, reviewedRecords) {
  const previous = new Map(reviewedRecords.map(site => [siteIdentity(site), site]));
  return actual.map(site => {
    const reviewed = previous.get(siteIdentity(site));
    return {
      ...suggestedSiteRecord(site),
      classification: reviewed?.classification ?? 'UNCLASSIFIED',
      authorityId: reviewed?.authorityId ?? 'UNCLASSIFIED',
      accessLane: reviewed?.accessLane ?? 'UNCLASSIFIED',
    };
  });
}

function mismatchMessage(expected, actual) {
  const removed = [];
  const added = [];
  const changed = [];
  for (const [id, count] of Object.entries(expected)) {
    if (!(id in actual)) removed.push({ id, count });
    else if (actual[id] !== count) changed.push({ id, expected: count, actual: actual[id] });
  }
  for (const [id, count] of Object.entries(actual)) {
    if (!(id in expected)) added.push({ id, count });
  }
  const render = value => JSON.stringify(value);
  const lines = ['Session authority inventory drifted. Classify the change, then run `pnpm audit:session-state -- --update`.'];
  for (const item of removed.slice(0, 12)) lines.push(`- removed: ${render(item)}`);
  for (const item of added.slice(0, 12)) lines.push(`+ added: ${render(item)}`);
  for (const item of changed.slice(0, 12)) lines.push(`~ count: ${render(item)}`);
  const hidden = removed.length + added.length + changed.length - Math.min(removed.length, 12)
    - Math.min(added.length, 12) - Math.min(changed.length, 12);
  if (hidden > 0) lines.push(`... ${hidden} more change(s)`);
  return lines.join('\n');
}

function summarize(sites) {
  const counts = new Map();
  for (const site of sites) {
    counts.set(site.receiverKind, (counts.get(site.receiverKind) ?? 0) + site.count);
  }
  return [...counts.entries()].sort(([left], [right]) => compareText(left, right))
    .map(([kind, count]) => `${kind}=${count}`).join(', ');
}

export function auditSessionStateInventory({ update = false } = {}) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const program = createSessionStateAuditProgram();
  const authorityClasses = validateManualInventory(inventory, program);
  const actual = collectSessionStateInventory({ program });
  const actualSnapshot = mechanicalSnapshot(actual);
  if (update) {
    inventory.mutationSites = mergeReviewedMutationSites(actual, inventory.mutationSites ?? []);
    writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
    validateMutationAnnotations(inventory.mutationSites, authorityClasses);
    return { updated: true, summary: summarize(actual) };
  }
  validateMutationAnnotations(inventory.mutationSites, authorityClasses);
  const expected = mechanicalSnapshot(inventory.mutationSites);
  if (JSON.stringify(expected) !== JSON.stringify(actualSnapshot)) {
    throw new Error(mismatchMessage(expected, actualSnapshot));
  }
  return { updated: false, summary: summarize(actual) };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = auditSessionStateInventory({ update: process.argv.includes('--update') });
    console.log(`[session-state-audit] ${result.updated ? 'updated' : 'verified'}: ${result.summary}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
