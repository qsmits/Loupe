"""Render successes and remaining limitations of continuation admission."""
from contextlib import ExitStack
from pathlib import Path
import argparse
import runpy
from unittest.mock import patch

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=Path('experiments/fringe-continuation-checks/examples.png'))
    parser.add_argument('--cache-dir', type=Path, default=Path('/tmp/loupe-continuation-cache'))
    args = parser.parse_args()
    runner = runpy.run_path(str(Path(__file__).with_name('experiment-fringe-continuation-checks.py')))
    cases = {c['name']: c for suite in ('matrix', 'blind', 'fresh') for c in runner['fixtures'](suite)}
    examples = [('blind-quartic-7', 'Previous curved-surface failure'),
                ('fresh-ridge-1', 'Fresh test: localized ridge'),
                ('noisy-hole-flat', 'Clean flat: retain useful coverage'),
                ('fresh-distortion-1', 'Fresh test: optical distortion remains')]
    methods = ['padded-composite', 'structured', 'cv-rim-structured']
    labels = ['Previous composite', 'Residual check', 'Rim + residual checks']
    fig, axes = plt.subplots(len(examples), 4, figsize=(13, 12), layout='constrained')
    cmap = plt.get_cmap('coolwarm').copy(); cmap.set_bad('#303844')
    with ExitStack() as stack:
        for name in ('render_surface_map', 'render_profile', 'render_fft_image',
                     'render_modulation_map', 'render_confidence_maps', 'render_zernike_chart'):
            stack.enter_context(patch.object(runner['E']['f'], name, lambda *a, **kw: ''))
        stack.enter_context(patch.object(runner['E']['f'], '_edge_inspection', lambda *a, **kw: {}))
        for row, (name, title) in enumerate(examples):
            case = cases[name]
            records, outputs, source, _ = runner['run_case'](case, args.cache_dir)
            metrics = {r['method']: r for r in records}
            axes[row, 0].imshow(case['image'], cmap='gray', vmin=0, vmax=255)
            axes[row, 0].set_title(title, fontsize=10)
            axes[row, 0].set_ylabel(name)
            y, x = np.indices(case['image'].shape)
            theta = source['metadata']['carrier_angle_rad']
            scale = np.sign(np.cos(theta)*case['fx']+np.sin(theta)*case['fy'])*632.8/(4*np.pi)
            for col, (method, label) in enumerate(zip(methods, labels), 1):
                output = outputs[method]; valid = output['valid']
                error = output['phase']*scale-case['truth']
                design = np.column_stack([np.ones(valid.sum()), x[valid], y[valid]])
                coeff = np.linalg.lstsq(design, error[valid], rcond=None)[0]
                error -= coeff[0]+coeff[1]*x+coeff[2]*y
                shown = axes[row, col].imshow(np.ma.array(error, mask=~valid), cmap=cmap, vmin=-2, vmax=2)
                axes[row, col].contour(source['valid'], levels=[.5], colors=['#202b38'], linewidths=.5)
                r = metrics[method]
                axes[row, col].set_title(f'{label}\n{r["coverage_pct"]:.1f}% coverage')
                axes[row, col].set_xlabel(f'RMS {r["rms_error_nm"]:.3f} nm | max {r["max_error_nm"]:.3f} nm', fontsize=9)
            for ax in axes[row]: ax.set_xticks([]); ax.set_yticks([])
    fig.colorbar(shown, ax=axes[:, 1:], shrink=.7, extend='both', label='Height error (nm; colors saturate at ±2)')
    fig.suptitle('Testing continuation additions against withheld phase and image residuals\n'
                 'Dark gray = excluded; outline = original Hybrid coverage; errors remove only piston and tilt', fontsize=12)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.output, dpi=150, bbox_inches='tight', pad_inches=.15)
    plt.close(fig)
    print(args.output)


if __name__ == '__main__': main()
