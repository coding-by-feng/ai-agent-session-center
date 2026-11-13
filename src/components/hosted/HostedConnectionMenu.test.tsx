import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import HostedConnectionMenu, { useHostedControls } from './HostedConnectionMenu';
import { useWsStore } from '@/stores/wsStore';
let meta: HTMLMetaElement;
beforeEach(()=>{meta=document.createElement('meta');meta.name='aasc-hosted-parent';meta.content='https://xclaude.dev';document.head.append(meta);useWsStore.setState({connected:true,snapshotReceived:true});});
afterEach(()=>{cleanup();meta.remove();useHostedControls.setState({pair:null});});
it('keeps status and pairing inside a header menu until opened',()=>{
 const pair=vi.fn();useHostedControls.setState({pair});render(<header><HostedConnectionMenu /></header>);
 expect(screen.queryByText('Hosted Full connected')).toBeNull();expect(screen.queryByText('配对手机')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'工作区连接：已连接'}));
 expect(screen.getByRole('menu')).toBeTruthy();expect(screen.getByRole('status').textContent).toBe('Hosted Full connected');
 fireEvent.click(screen.getByRole('menuitem',{name:'配对手机'}));expect(pair).toHaveBeenCalledTimes(1);expect(screen.queryByRole('menu')).toBeNull();
});
it('shows recovery when disconnected and closes on Escape',()=>{
 useWsStore.setState({connected:false});render(<HostedConnectionMenu />);
 const button=screen.getByRole('button',{name:'工作区连接：连接中断'});fireEvent.click(button);
 expect(screen.getByRole('menuitem',{name:'重新连接'})).toBeTruthy();fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});expect(screen.queryByRole('menu')).toBeNull();
});
it('does not add a connection control to ordinary local clients',()=>{meta.remove();const {container}=render(<HostedConnectionMenu />);expect(container.childElementCount).toBe(0);});
