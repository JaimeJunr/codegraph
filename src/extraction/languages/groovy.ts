import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Groovy return types that can't be a chained-call receiver.
 * `def` is dynamic — no static receiver to chain on.
 */
const GROOVY_NON_CLASS_RETURN_NODES = new Set([
  'void_type',
  'integral_type',
  'floating_point_type',
  'boolean_type',
]);

function extractGroovyReturnType(node: SyntaxNode, source: string): string | undefined {
  const typeNode = getChildByField(node, 'type');
  if (!typeNode) return undefined;
  if (typeNode.type === 'type_identifier' && getNodeText(typeNode, source).trim() === 'def') {
    return undefined;
  }
  if (GROOVY_NON_CLASS_RETURN_NODES.has(typeNode.type)) return undefined;
  if (typeNode.type === 'array_type') return undefined;
  const raw = getNodeText(typeNode, source).trim().replace(/<[^>]*>/g, '');
  const last = raw.split('.').pop()?.trim();
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

function readModifiers(node: SyntaxNode): string | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'modifiers') return child.text;
  }
  return undefined;
}

export const groovyExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: [],
  importTypes: ['import_declaration'],
  callTypes: ['method_invocation'],
  variableTypes: ['local_variable_declaration'],
  fieldTypes: ['field_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getReturnType: extractGroovyReturnType,

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'type');
    if (!params) return undefined;
    const paramsText = getNodeText(params, source);
    return returnType ? getNodeText(returnType, source) + ' ' + paramsText : paramsText;
  },

  getVisibility: (node) => {
    const text = readModifiers(node);
    if (!text) return undefined;
    if (text.includes('public')) return 'public';
    if (text.includes('private')) return 'private';
    if (text.includes('protected')) return 'protected';
    return undefined;
  },

  isStatic: (node) => {
    const text = readModifiers(node);
    return text ? /\bstatic\b/.test(text) : false;
  },

  isConst: (node) => {
    const text = readModifiers(node);
    return text ? /\bstatic\b/.test(text) && /\bfinal\b/.test(text) : false;
  },

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const scopedId = node.namedChildren.find((c: SyntaxNode) => c.type === 'scoped_identifier');
    if (scopedId) {
      const moduleName = source.substring(scopedId.startIndex, scopedId.endIndex);
      return { moduleName, signature: importText };
    }
    const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (id) {
      const moduleName = source.substring(id.startIndex, id.endIndex);
      return { moduleName, signature: importText };
    }
    return null;
  },

  packageTypes: ['package_declaration'],
  extractPackage: (node, source) => {
    const id = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'scoped_identifier' || c.type === 'identifier',
    );
    return id ? source.substring(id.startIndex, id.endIndex).trim() : null;
  },

  visitNode: (node, ctx) => {
    // `trait Foo { ... }` parses as `trait Foo` (juxt_function_call) + closure body.
    // The grammar has no native trait_declaration node.
    if (node.type === 'juxt_function_call') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode || getNodeText(nameNode, ctx.source) !== 'trait') return false;

      const args = node.childForFieldName('args');
      const traitNameNode = args?.namedChild(0);
      if (!traitNameNode || traitNameNode.type !== 'identifier') return false;
      const name = getNodeText(traitNameNode, ctx.source);
      if (!name) return false;

      const traitNode = ctx.createNode('trait', name, node);
      if (!traitNode) return false;

      ctx.pushScope(traitNode.id);

      // Body is typically the next sibling closure on the program.
      const parent = node.parent;
      if (parent) {
        const idx = parent.children.indexOf(node);
        const next = idx >= 0 ? parent.child(idx + 1) : null;
        const closure =
          next?.type === 'expression_statement'
            ? next.namedChildren.find((c: SyntaxNode) => c.type === 'closure')
            : next?.type === 'closure'
              ? next
              : null;
        if (closure) {
          for (let i = 0; i < closure.namedChildCount; i++) {
            const child = closure.namedChild(i);
            if (child) ctx.visitNode(child);
          }
        }
      }

      ctx.popScope();
      return true;
    }

    return false;
  },
};
