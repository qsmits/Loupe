"""Regenerate the edge-estimator research figures from recorded CSV and fixtures.

MPLCONFIGDIR=/tmp/loupe-mpl OPENBLAS_NUM_THREADS=1 .venv/bin/python scripts/report-fringe-local-fit.py
"""
from pathlib import Path
from contextlib import ExitStack
from unittest.mock import patch
import csv
import runpy
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'experiments/fringe-local-fit'
E=runpy.run_path(str(ROOT/'scripts/experiment-fringe-local-fit.py'))
f=E['f']
plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False,
                     'figure.facecolor':'white','savefig.facecolor':'white'})
rows=list(csv.DictReader((OUT/'results.csv').open()))
fig,axes=plt.subplots(1,2,figsize=(11,4.7),layout='constrained')
for run,color,label in [('refined-matrix','#007f78','36 original cases'),
                        ('refined-stress','#b87516','60 angle/noise holdouts'),
                        ('refined-challenge','#9b3988','30 difficult-image holdouts')]:
    selected=[r for r in rows if r['run']==run]
    base={r['case']:r for r in selected if r['method']=='bounded'}
    new=[r for r in selected if r['method']=='refined:.4:.4:1']
    for ax,key in zip(axes,['coverage_pct','rms_error_nm']):
        ax.scatter([max(float(base[r['case']][key]),1e-6) for r in new],
                   [max(float(r[key]),1e-6) for r in new],s=22,c=color,alpha=.75,label=label)
axes[0].plot([0,100],[0,100],':',color='#555');axes[0].set(xlim=(0,100),ylim=(0,100),
    xlabel='Current coverage (% of physical part)',ylabel='Research coverage (%)',title='More measured area in 121 of 126 scenes')
axes[1].plot([1e-6,100],[1e-6,100],':',color='#555');axes[1].set(xscale='log',yscale='log',
    xlabel='Current RMS height error (nm)',ylabel='Research RMS height error (nm)',title='Lower error in only 56 of 126 scenes')
axes[0].legend(loc='upper left',frameon=False,fontsize=8)
fig.suptitle('Local fringe fitting + carrier refinement: benefit and limits',fontsize=14)
fig.savefig(OUT/'tradeoffs.png',dpi=160);plt.close(fig)


def aligned(case,observed):
    valid=observed['valid'];y,x=np.indices(valid.shape);truth=case['truth'];height=observed['height']
    design=np.column_stack([np.ones(valid.sum()),x[valid],y[valid]])
    coeff=np.linalg.lstsq(design,(height-truth)[valid],rcond=None)[0]
    return height-(coeff[0]+coeff[1]*x+coeff[2]*y)


with ExitStack() as stack:
    for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
        stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
    stack.enter_context(patch.object(f,'_edge_inspection',lambda *a,**kw:{}))
    case=next(c for c in E['B']['fixtures']() if c['name']=='noisy-hole-flat')
    base,_=E['evaluate'](case,'bounded');new,_=E['evaluate'](case,'refined:.4:.4:1')
    fig,axes=plt.subplots(1,3,figsize=(11,4.1),layout='constrained')
    axes[0].imshow(case['image'],cmap='gray');axes[0].set_title('Synthetic flat part with a hole\n2-level camera noise')
    cmap=plt.get_cmap('RdBu_r').copy();cmap.set_bad('#e0e0e0')
    for ax,obs,title in [(axes[1],base,'Current method'),(axes[2],new,'Research local fit')]:
        stats=E['B']['metrics'](case,obs,base)
        error=aligned(case,obs)-case['truth']
        im=ax.imshow(np.ma.array(error,mask=~obs['valid']),cmap=cmap,vmin=-.8,vmax=.8)
        ax.set_title(f'{title}\n{stats["coverage_pct"]:.1f}% coverage · {stats["rms_error_nm"]:.3f} nm RMS error')
    for ax in axes:ax.set_xticks([]);ax.set_yticks([])
    fig.colorbar(im,ax=axes[1:],shrink=.7,label='Height error against known flat surface (nm)')
    fig.suptitle('More than twice the measured area, with similar error in this case',fontsize=13)
    fig.savefig(OUT/'noisy-hole.png',dpi=160);plt.close(fig)

    case=next(c for c in E['B']['fixtures']() if c['name']=='broad-roll-17.4')
    fig,ax=plt.subplots(figsize=(10,4.5),layout='constrained')
    y=int(.47*case['image'].shape[0]);physical=case['physical'][y];x=np.arange(len(physical))
    ax.plot(x,np.where(physical,case['truth'][y],np.nan),color='#222',lw=2,label='Known surface')
    for method,label,color in [('bounded','Current','#9b3988'),('refined:.4:.4:1','Local linear + carrier refinement','#007f78'),
                                ('local:.5:.3:2','Local quadratic (unstable on other scenes)','#b87516')]:
        obs,_=E['evaluate'](case,method)
        ax.plot(x,np.where(obs['valid'][y],aligned(case,obs)[y],np.nan),color=color,lw=1.8,label=label)
    ax.set(xlabel='Horizontal position (image pixels)',ylabel='Height (nm)',title='Broad edge roll-off: a successful example, not a universal result')
    ax.legend(frameon=False,loc='lower center',fontsize=9)
    ax.grid(alpha=.15)
    fig.savefig(OUT/'rolloff-profile.png',dpi=160);plt.close(fig)
print(OUT)
