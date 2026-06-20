import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * Groovy extractor for the `murtaza64/tree-sitter-groovy` grammar (ABI 15).
 *
 * Node scheme (very different from the java-derived grammars):
 *   - class / interface → `class_definition` (name field `name`, body field `body` = a `closure`;
 *     the `class`/`interface` keyword is an ANONYMOUS child).
 *   - method / function → `function_definition` (with body) and `function_declaration` (no body,
 *     in interfaces). NAME lives in the `function` field — NOT `name`. Return type in `type`.
 *   - field / local var → `declaration` (name field `name`, modifiers via `access_modifier`/`modifier`).
 *   - import → `groovy_import` (qualified name in the `import` field); package → `groovy_package`.
 *   - call → `function_call` and `juxt_function_call` (paren-less call, e.g. `render foo`).
 *   - `enum` and `trait` are NOT keywords in this grammar — they parse as
 *     `identifier identifier closure` siblings and are recovered in `visitNode`.
 */

/** Concatenated text of a node's `access_modifier` / `modifier` children. */
function readModifierText(node: SyntaxNode): string {
  const parts: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && (c.type === 'access_modifier' || c.type === 'modifier')) parts.push(c.text);
  }
  return parts.join(' ');
}

/** Create enum_member nodes from the (error-recovered) enum body closure. */
function collectEnumMembers(closure: SyntaxNode, ctx: ExtractorContext): void {
  const walk = (node: SyntaxNode) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'parameter') {
        const nameNode = getChildByField(child, 'name') ?? child.namedChild(0);
        if (nameNode) ctx.createNode('enum_member', getNodeText(nameNode, ctx.source), nameNode);
      } else {
        // Descend through ERROR / parameter_list wrappers the grammar emits.
        walk(child);
      }
    }
  };
  walk(closure);
}

export const groovyExtractor: LanguageExtractor = {
  // function_definition is in BOTH function and method lists: the orchestrator
  // picks `method` when inside a class-like scope, `function` otherwise.
  functionTypes: ['function_definition', 'function_declaration'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition', 'function_declaration'],
  interfaceTypes: [], // interfaces reuse class_definition → classifyClassNode
  structTypes: [],
  enumTypes: [], // enum is not a grammar keyword → recovered in visitNode
  typeAliasTypes: [],
  importTypes: ['groovy_import'],
  callTypes: ['function_call', 'juxt_function_call'],
  // `declaration` is in BOTH lists: field when its immediate parent is class-like,
  // variable otherwise (the orchestrator gates on isInsideClassLikeNode).
  variableTypes: ['declaration'],
  fieldTypes: ['declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',

  // function_definition/declaration name lives in the `function` field, not `name`.
  resolveName: (node, source) => {
    if (node.type === 'function_definition' || node.type === 'function_declaration') {
      const fn = getChildByField(node, 'function');
      return fn ? getNodeText(fn, source) : undefined;
    }
    return undefined;
  },

  classifyClassNode: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && !c.isNamed && c.type === 'interface') return 'interface';
    }
    return 'class';
  },

  getReturnType: (node, source) => {
    const typeNode = getChildByField(node, 'type');
    if (!typeNode) return undefined;
    const raw = getNodeText(typeNode, source).trim().replace(/<[^>]*>/g, '');
    const last = raw.split('.').pop()?.trim();
    // Only class-like return types (PascalCase) — skips def/void/int/String-of-primitives.
    if (!last || !/^[A-Z]\w*$/.test(last)) return undefined;
    return last;
  },

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const typeNode = getChildByField(node, 'type');
    const paramsText = params ? getNodeText(params, source) : '()';
    return typeNode ? `${getNodeText(typeNode, source)} ${paramsText}` : paramsText;
  },

  getVisibility: (node) => {
    const text = readModifierText(node);
    if (text.includes('private')) return 'private';
    if (text.includes('protected')) return 'protected';
    if (text.includes('public')) return 'public';
    return undefined;
  },

  isStatic: (node) => /\bstatic\b/.test(readModifierText(node)),
  isConst: (node) => {
    const text = readModifierText(node);
    return /\bstatic\b/.test(text) && /\bfinal\b/.test(text);
  },

  extractImport: (node, source) => {
    const full = source.substring(node.startIndex, node.endIndex).trim();
    const qn =
      getChildByField(node, 'import') ??
      node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'qualified_name' || c.type === 'identifier',
      );
    if (!qn) return null;
    let moduleName = getNodeText(qn, source).trim();
    if (node.namedChildren.some((c: SyntaxNode) => c.type === 'wildcard_import')) {
      moduleName += '.*';
    }
    return { moduleName, signature: full };
  },

  packageTypes: ['groovy_package'],
  extractPackage: (node, source) => {
    const qn = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'qualified_name' || c.type === 'identifier',
    );
    return qn ? getNodeText(qn, source).trim() : null;
  },

  visitNode: (node, ctx) => {
    // `trait Foo { ... }` / `enum Bar { ... }` have no grammar keyword — both parse
    // as `identifier(kw) identifier(name) closure` siblings. Detect on the CLOSURE
    // (the body) so we handle every member in one pass and return true, which stops
    // the orchestrator from re-visiting the closure's children as top-level symbols.
    if (node.type === 'closure') {
      const nameSib = node.previousNamedSibling;
      const kwSib = nameSib?.previousNamedSibling;
      if (nameSib?.type === 'identifier' && kwSib?.type === 'identifier') {
        const kw = getNodeText(kwSib, ctx.source);
        const name = getNodeText(nameSib, ctx.source);

        if (kw === 'trait') {
          const traitNode = ctx.createNode('trait', name, kwSib);
          if (!traitNode) return false;
          ctx.pushScope(traitNode.id);
          for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child) ctx.visitNode(child);
          }
          ctx.popScope();
          return true;
        }

        if (kw === 'enum') {
          const enumNode = ctx.createNode('enum', name, kwSib);
          if (!enumNode) return false;
          ctx.pushScope(enumNode.id);
          collectEnumMembers(node, ctx);
          ctx.popScope();
          return true;
        }
      }
    }
    return false;
  },
};
