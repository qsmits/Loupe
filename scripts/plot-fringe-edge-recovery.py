"""Render representative successes and failures from the fixed recovery study."""
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
import argparse
import runpy

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=Path('experiments/fringe-edge-recovery/examples.png'))
    args = parser.parse_args()
    experiment = runpy.run_path(str(Path(__file__).with_name('experiment-fringe-edge-recovery.py')))
    cases = {case['name']: case for case in experiment['B']['fixtures']()}
    cases.update({case['name']: case for case in experiment['blind_fixtures']()})
    examples = [('noisy-hole-flat', 'Clean flat with a hole'),
                ('narrow-roll-17.4', 'Abrupt edge roll-off'),
                ('noisy-frame-flat', 'Flat fills the photograph'),
                ('blind-quartic-7', 'Blind test: more complex curvature')]
    methods = ['hybrid', 'bank-strict', 'continuation-validated', 'padded-composite']
    titles = ['Existing Hybrid', 'Strict window consensus', 'Unpadded continuation', 'Padded composite']
    fig, axes = plt.subplots(len(examples), 5, figsize=(15, 3*len(examples)), layout='constrained')
    cmap = plt.get_cmap('coolwarm').copy()
    cmap.set_bad('#303844')
    with ExitStack() as stack:
        for name in ('render_surface_map', 'render_profile', 'render_fft_image',
                     'render_modulation_map', 'render_confidence_maps', 'render_zernike_chart'):
            stack.enter_context(patch.object(experiment['f'], name, lambda *a, **kw: ''))
        stack.enter_context(patch.object(experiment['f'], '_edge_inspection', lambda *a, **kw: {}))
        for row, (name, label) in enumerate(examples):
            case = cases[name]
            records, outputs, source = experiment['run_case'](
                case, ['bank-strict', 'continuation-validated', 'padded-composite'])
            metrics = {record['method']: record for record in records}
            axes[row, 0].imshow(case['image'], cmap='gray', vmin=0, vmax=255)
            axes[row, 0].set_title(label)
            axes[row, 0].set_ylabel(name)
            y, x = np.indices(case['image'].shape)
            for col, (method, title) in enumerate(zip(methods, titles), 1):
                result = outputs[method]
                valid = result['valid']
                error = result['height'] - case['truth']
                design = np.column_stack([np.ones(valid.sum()), x[valid], y[valid]])
                coeff = np.linalg.lstsq(design, error[valid], rcond=None)[0]
                error -= coeff[0] + coeff[1]*x + coeff[2]*y
                field = np.ma.array(error, mask=~valid)
                ax = axes[row, col]
                shown = ax.imshow(field, cmap=cmap, vmin=-2, vmax=2)
                if (valid & ~source['valid']).any():
                    ax.contour(source['valid'], levels=[.5], colors=['#202b38'], linewidths=.5)
                metric = metrics[method]
                ax.set_title(f'{title}\n{metric["coverage_pct"]:.1f}% coverage')
                ax.set_xlabel(f'RMS {metric["rms_error_nm"]:.3f} nm | max {metric["max_error_nm"]:.3f} nm')
            for ax in axes[row]:
                ax.set_xticks([])
                ax.set_yticks([])
    fig.colorbar(shown, ax=axes[:, 1:], shrink=.7, extend='both',
                 label='Height error against analytic truth (nm; colors saturate at ±2)')
    fig.suptitle('Synthetic edge recovery: extra coverage can conceal large local errors\n'
                 'Dark gray = excluded; black line = original Hybrid boundary; each map removes only piston and tilt', fontsize=13)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.output, dpi=150, bbox_inches="tight", pad_inches=.15)
    plt.close(fig)
    print(args.output)


if __name__ == '__main__':
    main()
