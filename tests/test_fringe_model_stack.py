"""Safety properties of the research stack, independent of synthetic fit scores."""
from pathlib import Path
import sys
import numpy as np
import pytest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from fringe_model_stack import stack_models,stack_tiers
from backend.vision.fringe_hybrid import local_phase


def scene():
    shape=(20,30);phase=np.zeros(shape);mask=np.ones(shape,bool)
    anchors=np.zeros(shape,bool);anchors[:,:5]=True
    fields=dict(source=anchors.astype(np.uint8),conflict=np.zeros(shape,bool))
    return phase,fields,anchors,mask


def test_stack_keeps_earlier_values_and_first_model_provenance():
    p,f,a,m=scene();p[a]=.2;one=np.full(p.shape,.21);two=np.full(p.shape,.22)
    s1=m.copy();s1[:,20:]=False
    result,added,source,d=stack_models(p,f,a,m,{'one':(one,s1),'two':(two,m)},['one','two'])
    np.testing.assert_array_equal(result[a],p[a]);np.testing.assert_array_equal(source[a],f['source'][a])
    assert np.all(result[:,5:20]==.21) and np.all(result[:,20:]==.22)
    assert np.all(source[:,5:20]==6) and np.all(source[:,20:]==7)
    assert added.sum()==500 and d['remaining_old_order_conflict_pixels']==0


def test_unwrapped_disagreement_blocks_bridges_without_reanchoring():
    p,f,a,m=scene();one=np.zeros(p.shape);two=one.copy();two[:,12]=2*np.pi
    result,added,source,d=stack_models(p,f,a,m,{'one':(one,m),'two':(two,m)},['one','two'])
    assert d['disagreement_pixels']==20
    assert added[:,5:11].all() and not added[:,11:].any()
    assert not source[:,11:].any()


def test_one_candidate_cannot_seed_another_disconnected_candidate():
    p,f,a,m=scene();s1=m.copy();s1[:,15:]=False;s2=m.copy();s2[:,:10]=False
    result,added,source,d=stack_models(p,f,a,m,{'one':(p,s1),'two':(p,s2)},['one','two'])
    assert added[:,5:15].all() and not added[:,15:].any()


def test_order_conflict_removes_additions_without_damaging_old_layer():
    p,f,a,m=scene()
    def joint_check(phase,valid):
        # Simulate an alternate-path conflict only after new pixels connect.
        return (valid.copy() if (valid&~a).any() else np.zeros_like(valid)),{}
    with patch('fringe_model_stack.c.order_check',joint_check):
        result,added,source,d=stack_models(p,f,a,m,{'one':(p,m)},['one'])
    assert not added.any() and d['joint_order_rejected_pixels']==500
    assert d['joint_order_passes']==2
    np.testing.assert_array_equal(result,p);np.testing.assert_array_equal(source,f['source'])


def test_existing_conflict_and_aperture_cannot_be_filled():
    p,f,a,m=scene();f['conflict'][7:10,8:10]=True;m[15:,25:]=False
    result,added,source,d=stack_models(p,f,a,m,{'one':(p,np.ones_like(m))},['one'])
    assert not (added&(~m|f['conflict'])).any()


def test_lower_tier_cannot_veto_or_overwrite_earlier_measurements():
    p,f,a,m=scene();first=np.full(p.shape,.01);later=np.full(p.shape,.02)
    support=m.copy();support[:,18:]=False
    later[7:10,11:14]=.2  # Disagreement within the already accepted first tier.
    pool={'first':(first,support),'later':(later,m)}
    before,bm,bs,_=stack_models(p,f,a,m,pool,['first'])
    result,added,source,d=stack_tiers(p,f,a,m,pool,[['first'],['later']])
    np.testing.assert_array_equal(result[a|bm],before[a|bm])
    np.testing.assert_array_equal(source[a|bm],bs[a|bm])
    assert np.all(added[bm]) and added[:,18:].any()
    assert d['earlier_tiers_preserved']


@pytest.mark.parametrize('degree',[1,2])
def test_second_harmonic_recovers_fundamental_phase_across_tile_seams(degree):
    y,x=np.mgrid[:56,:64];fx,fy=.09,.04;carrier=2*np.pi*(fx*x+fy*y);phi=.63
    mask=((x-32)/29)**2+((y-28)/25)**2<1
    mask &= np.hypot(x-28,y-30)>4
    image=130+.15*x-.11*y+(29+.03*x)*np.cos(carrier+phi)+(9+.04*y)*np.cos(2*carrier+.42)
    full_diag={};tile_diag={}
    full=local_phase(image,mask,fx,fy,5,3,degree,full_diag,harmonics=2,_tile_size=256)
    tiled=local_phase(image,mask,fx,fy,5,3,degree,tile_diag,harmonics=2,_tile_size=20)
    reliable=mask&(full[1]<1000)
    assert reliable.sum()>500
    assert np.abs(np.angle(np.exp(1j*(full[0][reliable]-phi)))).max()<1e-6
    np.testing.assert_allclose(np.angle(np.exp(1j*(full[0][reliable]-tiled[0][reliable]))),0,atol=1e-9)
    np.testing.assert_allclose(full[1][reliable],tiled[1][reliable],rtol=1e-8)
    np.testing.assert_allclose(full_diag['residual'][reliable],tile_diag['residual'][reliable],atol=2e-6)
