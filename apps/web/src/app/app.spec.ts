import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { App } from './app';

@Component({ template: `<p data-testid="routed">routed page</p>` })
class RoutedPage {}

describe('App (root component)', () => {
  it('renders the routed page in its outlet, with no layout of its own', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: 'somewhere', component: RoutedPage }])],
    });
    const fixture = TestBed.createComponent(App);
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('[data-testid=routed]')).toBeNull();

    await TestBed.inject(Router).navigateByUrl('/somewhere');
    await fixture.whenStable();

    expect(root.querySelector('[data-testid=routed]')?.textContent).toBe('routed page');
    expect([...root.children].map((child) => child.tagName.toLowerCase())).toEqual([
      'router-outlet',
      'ng-component',
    ]);
  });
});
