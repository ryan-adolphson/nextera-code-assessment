import { TestBed } from '@angular/core/testing';
import { appConfig } from './app.config';
import { API_BASE_URL } from './core/api-base-url';

describe('appConfig', () => {
  it('provides the API base URL resolved before bootstrap', () => {
    TestBed.configureTestingModule({
      providers: appConfig('https://api.nextera.energy/api').providers,
    });
    expect(TestBed.inject(API_BASE_URL)).toBe('https://api.nextera.energy/api');
  });
});
