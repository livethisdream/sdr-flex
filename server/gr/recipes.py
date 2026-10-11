#!/usr/bin/env python3
"""SDR Flex's recipes, read from their .grc files (ADR-0043).

A recipe is a GNU Radio Companion hier block. What SDR Flex needs beyond what GRC records is
in the recipe's own `sdrflex_recipe` block (grc/sdrflex_recipe.block.yml), which GNU Radio
ignores at run time; everything else is GRC's: the title, the hier block's id, its
parameters and their values, the blocks and how they connect.

Run as a program, it prints every recipe in the directory as JSON, which is how the server
learns what to put in the menu without a YAML parser of its own.

  recipes.py [dir]
"""
import json
import os
import sys

import yaml

RECIPES = os.environ.get('SDRFLEX_RECIPES') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'recipes')
GRC_BLOCKS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'grc')

# The parameters SDR Flex fills from the stream rather than from a person.
FROM_STREAM = {'samp_rate', 'start_index'}


def describe(path):
    """One recipe: its name, its metadata, its parameters, its blocks. Raises on a .grc that is
    not a recipe, saying what is missing, rather than loading half of one."""
    with open(path) as f:
        doc = yaml.safe_load(f)
    opts = (doc.get('options') or {}).get('parameters') or {}
    blocks = doc.get('blocks') or []
    meta = [b for b in blocks if b.get('id') == 'sdrflex_recipe']
    name = os.path.splitext(os.path.basename(path))[0]
    if opts.get('generate_options') != 'hb':
        raise ValueError(f'{name}: not a hier block (generate_options is {opts.get("generate_options")!r})')
    if len(meta) != 1:
        raise ValueError(f'{name}: needs exactly one "SDR Flex recipe" block, has {len(meta)}')
    m = meta[0].get('parameters') or {}
    params = {}
    for b in blocks:
        if b.get('id') != 'parameter':
            continue
        p = b.get('parameters') or {}
        params[b['name']] = {
            'label': p.get('label') or b['name'],
            'value': p.get('value'),
            'type': p.get('type'),
            'fromStream': b['name'] in FROM_STREAM,
            'comment': p.get('comment') or '',
        }
    derived = {}
    for pair in str(m.get('derived') or '').split(','):
        if '=' in pair:
            k, v = (x.strip() for x in pair.split('=', 1))
            if k not in params:
                raise ValueError(f'{name}: derives {k!r}, which is not one of its parameters')
            derived[k] = v
    out = {
        'name': name,
        'title': opts.get('title') or name,
        'block': opts.get('id') or name,
        'description': opts.get('description') or '',
        'kind': m.get('kind', 'node'),
        'node': m.get('node') or None,
        'input': m.get('input', 'iq'),
        'output': m.get('output', 'real'),
        'listen': m.get('listen') == 'yes',
        'history': m.get('history') or None,
        'derived': derived,
        'params': params,
        'blocks': [{'id': b['id'], 'name': b['name'], 'params': b.get('parameters') or {}}
                   for b in blocks if b.get('id') not in ('parameter', 'variable', 'import',
                                                          'sdrflex_recipe', 'pad_source',
                                                          'pad_sink', 'note', 'options')
                   and (b.get('states') or {}).get('state', 'enabled') == 'enabled'],
        'connections': doc.get('connections') or [],
    }
    if out['kind'] == 'node' and not out['node']:
        raise ValueError(f'{name}: folds into a node but does not say which')
    return out


def all_recipes(directory=RECIPES, mine=False):
    found, errors = [], []
    for f in sorted(os.listdir(directory)) if os.path.isdir(directory) else []:
        if f.endswith('.grc'):
            try:
                r = describe(os.path.join(directory, f))
                r['mine'] = mine
                found.append(r)
            except Exception as e:  # a broken recipe is reported, and the rest still load
                errors.append(f'{type(e).__name__}: {e}')
    return found, errors


if __name__ == '__main__':
    # The shipped recipes, then any saved on this box, which may not shadow a shipped one.
    found, errors = all_recipes(sys.argv[1] if len(sys.argv) > 1 else RECIPES)
    for d in sys.argv[2:]:
        more, errs = all_recipes(d, mine=True)
        taken = {r['name'] for r in found}
        found += [r for r in more if r['name'] not in taken]
        errors += errs
    print(json.dumps({'recipes': found, 'errors': errors}))
