import cookieParser from 'set-cookie-parser';
import { TOTP } from 'otpauth';
import { Got } from 'got';
import { Logger } from 'pino';
import logger from './common/logger';
import {
  CSRFSetCookies,
  LoginBody,
  RedirectResponse,
  MFABody,
  ReputationData,
} from './interfaces/types';
import { notifyManualCaptcha, EpicArkosePublicKey } from './captcha';
import {
  CSRF_ENDPOINT,
  LOGIN_ENDPOINT,
  EPIC_CLIENT_ID,
  REDIRECT_ENDPOINT,
  REPUTATION_ENDPOINT,
  EMAIL_VERIFY,
  STORE_HOMEPAGE,
  MFA_LOGIN_ENDPOINT,
  SET_SID_ENDPOINT,
} from './common/constants';
import { config } from './common/config';

export default class Login {
  private request: Got;

  private L: Logger;

  constructor(requestClient: Got, email: string) {
    this.request = requestClient;
    this.L = logger.child({
      user: email,
    });
  }

  async getCsrf(): Promise<string> {
    this.L.debug('Refreshing CSRF');
    this.L.trace({ url: CSRF_ENDPOINT }, 'CSRF request');
    const csrfResp = await this.request.get(CSRF_ENDPOINT);
    const cookies = (cookieParser(csrfResp.headers['set-cookie'] as string[], {
      map: true,
    }) as unknown) as CSRFSetCookies;
    return cookies['XSRF-TOKEN'].value;
  }

  async getReputation(): Promise<ReputationData> {
    this.L.trace({ url: REPUTATION_ENDPOINT }, 'Reputation request');
    const resp = await this.request.get<ReputationData>(REPUTATION_ENDPOINT);
    return resp.body;
  }

  async loginMFA(totpSecret?: string): Promise<void> {
    this.L.debug('Logging in with MFA');
    if (!totpSecret) throw new Error('TOTP required for MFA login');
    const csrfToken = await this.getCsrf();
    const totp = new TOTP({ secret: totpSecret });
    const mfaRequest: MFABody = {
      code: totp.generate(),
      method: 'authenticator',
      rememberDevice: true,
    };
    this.L.trace({ body: mfaRequest, url: MFA_LOGIN_ENDPOINT }, 'MFA request');
    await this.request.post(MFA_LOGIN_ENDPOINT, {
      json: mfaRequest,
      headers: {
        'x-xsrf-token': csrfToken,
      },
    });
  }

  async sendVerify(code: string): Promise<void> {
    const csrfToken = await this.getCsrf();
    const verifyBody = {
      verificationCode: code,
    };
    this.L.trace({ body: verifyBody, url: EMAIL_VERIFY }, 'Verify email request');
    await this.request.post(EMAIL_VERIFY, {
      json: verifyBody,
      headers: {
        'x-xsrf-token': csrfToken,
      },
    });
  }

  async login(
    email: string,
    password: string,
    captcha = '',
    totp = '',
    blob?: string,
    attempt = 0
  ): Promise<void> {
    this.L.debug({ email, captcha, attempt }, 'Attempting login');
    const csrfToken = await this.getCsrf();
    if (attempt > 5) {
      throw new Error('Too many login attempts');
    }
    const loginBody: LoginBody = {
      password,
      rememberMe: true,
      captcha,
      email,
    };
    try {
      this.L.trace({ body: loginBody, url: LOGIN_ENDPOINT }, 'Login request');
      await this.request.post(LOGIN_ENDPOINT, {
        json: loginBody,
        headers: {
          'x-xsrf-token': csrfToken,
        },
      });
      this.L.debug('Logged in');
    } catch (e) {
      if (e.response && e.response.body && e.response.body.errorCode) {
        if (e.response.body.errorCode.includes('session_invalidated')) {
          this.L.debug('Session invalidated, retrying');
          await this.login(email, password, captcha, totp, blob, attempt + 1);
        } else if (
          e.response.body.errorCode === 'errors.com.epicgames.accountportal.captcha_invalid'
        ) {
          this.L.debug('Captcha required');
          const captchaToken = await notifyManualCaptcha(EpicArkosePublicKey.LOGIN, blob);
          await this.login(email, password, captchaToken, totp, blob, attempt + 1);
        } else if (
          e.response.body.errorCode ===
          'errors.com.epicgames.common.two_factor_authentication.required'
        ) {
          await this.loginMFA(totp);
        } else {
          this.L.error(e.response.body, 'Login failed');
          throw e;
        }
      } else {
        this.L.error(e, 'Login failed');
        throw e;
      }
    }
  }

  /**
   * Sets the 'store-token' cookie which is necessary to authenticate on the GraphQL proxy endpoint
   */
  async getStoreToken(): Promise<void> {
    this.L.trace({ url: STORE_HOMEPAGE }, 'Request store homepage');
    const resp = await this.request.get(STORE_HOMEPAGE, { responseType: 'text' });
    this.L.trace({ headers: resp.headers }, 'Store homepage response headers');
  }

  async refreshAndSid(error: boolean): Promise<boolean> {
    this.L.debug('Setting SID');
    const csrfToken = await this.getCsrf();
    const redirectSearchParams = { clientId: EPIC_CLIENT_ID, redirectUrl: STORE_HOMEPAGE };
    this.L.trace({ params: redirectSearchParams, url: REDIRECT_ENDPOINT }, 'Redirect request');
    const redirectResp = await this.request.get<RedirectResponse>(REDIRECT_ENDPOINT, {
      headers: {
        'x-xsrf-token': csrfToken,
      },
      searchParams: redirectSearchParams,
    });
    const { sid } = redirectResp.body;
    if (!sid) {
      if (error) throw new Error('Sid returned null');
      return false;
    }
    const sidSearchParams = { sid };
    this.L.trace({ params: sidSearchParams, url: SET_SID_ENDPOINT }, 'Set SID request');
    const sidResp = await this.request.get(SET_SID_ENDPOINT, { searchParams: sidSearchParams });
    this.L.trace({ headers: sidResp.headers }, 'Set SID response headers');
    await this.getStoreToken();
    return true;
  }

  async fullLogin(
    email = config.accounts[0].email,
    password = config.accounts[0].password,
    totp = config.accounts[0].totp
  ): Promise<void> {
    if (await this.refreshAndSid(false)) {
      this.L.info('Successfully refreshed login');
    } else {
      this.L.debug('Could not refresh credentials. Logging in fresh.');
      const reputation = await this.getReputation();
      await this.login(email, password, '', totp, reputation.arkose_data.blob);
      await this.refreshAndSid(true);
      this.L.info('Successfully logged in fresh');
    }
  }
}
