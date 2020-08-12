/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FirebaseError, querystring } from '@firebase/util';
import {
  AuthErrorCode,
  AUTH_ERROR_FACTORY,
  NamedErrorParams
} from '../core/errors';
import { fail } from '../core/util/assert';
import { Delay } from '../core/util/delay';
import { AuthCore } from '../model/auth';
import { IdTokenResponse, TaggedWithTokenResponse } from '../model/id_token';
import { IdTokenMfaResponse } from './authentication/mfa';
import { ServerError, ServerErrorMap, SERVER_ERROR_MAP } from './errors';
import { FetchProvider } from '../core/util/fetch_provider';

export enum HttpMethod {
  POST = 'POST',
  GET = 'GET'
}

export enum HttpHeader {
  CONTENT_TYPE = 'Content-Type',
  X_FIREBASE_LOCALE = 'X-Firebase-Locale',
  X_CLIENT_VERSION = 'X-Client-Version'
}

export enum Endpoint {
  CREATE_AUTH_URI = '/v1/accounts:createAuthUri',
  DELETE_ACCOUNT = '/v1/accounts:delete',
  RESET_PASSWORD = '/v1/accounts:resetPassword',
  SIGN_UP = '/v1/accounts:signUp',
  SIGN_IN_WITH_CUSTOM_TOKEN = '/v1/accounts:signInWithCustomToken',
  SIGN_IN_WITH_EMAIL_LINK = '/v1/accounts:signInWithEmailLink',
  SIGN_IN_WITH_IDP = '/v1/accounts:signInWithIdp',
  SIGN_IN_WITH_PASSWORD = '/v1/accounts:signInWithPassword',
  SIGN_IN_WITH_PHONE_NUMBER = '/v1/accounts:signInWithPhoneNumber',
  SEND_VERIFICATION_CODE = '/v1/accounts:sendVerificationCode',
  SEND_OOB_CODE = '/v1/accounts:sendOobCode',
  SET_ACCOUNT_INFO = '/v1/accounts:update',
  GET_ACCOUNT_INFO = '/v1/accounts:lookup',
  GET_RECAPTCHA_PARAM = '/v1/recaptchaParams',
  START_PHONE_MFA_ENROLLMENT = '/v2/accounts/mfaEnrollment:start',
  FINALIZE_PHONE_MFA_ENROLLMENT = '/v2/accounts/mfaEnrollment:finalize',
  START_PHONE_MFA_SIGN_IN = '/v2/accounts/mfaSignIn:start',
  FINALIZE_PHONE_MFA_SIGN_IN = '/v2/accounts/mfaSignIn:finalize',
  WITHDRAW_MFA = '/v2/accounts/mfaEnrollment:withdraw'
}

export const DEFAULT_API_TIMEOUT_MS = new Delay(30_000, 60_000);

export async function _performApiRequest<T, V>(
  auth: AuthCore,
  method: HttpMethod,
  path: Endpoint,
  request?: T,
  customErrorMap: Partial<ServerErrorMap<ServerError>> = {}
): Promise<V> {
  return _performFetchWithErrorHandling(auth, customErrorMap, () => {
    let body = {};
    let params = {};
    if (request) {
      if (method === HttpMethod.GET) {
        params = request;
      } else {
        body = {
          body: JSON.stringify(request)
        };
      }
    }

    const query = querystring({
      key: auth.config.apiKey,
      ...params
    }).slice(1);

    const headers = new (FetchProvider.headers())();
    headers.set(HttpHeader.CONTENT_TYPE, 'application/json');
    headers.set(HttpHeader.X_CLIENT_VERSION, auth.config.sdkClientVersion);

    if (auth.languageCode) {
      headers.set(HttpHeader.X_FIREBASE_LOCALE, auth.languageCode);
    }

    return FetchProvider.fetch()(
      `${auth.config.apiScheme}://${auth.config.apiHost}${path}?${query}`,
      {
        method,
        headers,
        referrerPolicy: 'no-referrer',
        ...body
      }
    );
  });
}

export async function _performFetchWithErrorHandling<V>(
  auth: AuthCore,
  customErrorMap: Partial<ServerErrorMap<ServerError>>,
  fetchFn: () => Promise<Response>
): Promise<V> {
  const errorMap = { ...SERVER_ERROR_MAP, ...customErrorMap };
  try {
    const response: Response = await Promise.race<Promise<Response>>([
      fetchFn(),
      makeNetworkTimeout(auth.name)
    ]);

    const json = await response.json();
    if ('needConfirmation' in json) {
      throw makeTaggedError(auth, AuthErrorCode.NEED_CONFIRMATION, json);
    }

    if (response.ok) {
      return json;
    } else {
      const serverErrorCode = json.error.message.split(' : ')[0] as ServerError;
      if (serverErrorCode === ServerError.FEDERATED_USER_ID_ALREADY_LINKED) {
        throw makeTaggedError(
          auth,
          AuthErrorCode.CREDENTIAL_ALREADY_IN_USE,
          json
        );
      } else if (serverErrorCode === ServerError.EMAIL_EXISTS) {
        throw makeTaggedError(auth, AuthErrorCode.EMAIL_EXISTS, json);
      }

      const authError = errorMap[serverErrorCode];
      if (authError) {
        fail(authError, { appName: auth.name });
      } else {
        // TODO probably should handle improperly formatted errors as well
        // If you see this, add an entry to SERVER_ERROR_MAP for the corresponding error
        console.error(`Unexpected API error: ${json.error.message}`);
        fail(AuthErrorCode.INTERNAL_ERROR, { appName: auth.name });
      }
    }
  } catch (e) {
    if (e instanceof FirebaseError) {
      throw e;
    }
    fail(AuthErrorCode.NETWORK_REQUEST_FAILED, { appName: auth.name });
  }
}

export async function _performSignInRequest<T, V extends IdTokenResponse>(
  auth: AuthCore,
  method: HttpMethod,
  path: Endpoint,
  request?: T,
  customErrorMap: Partial<ServerErrorMap<ServerError>> = {}
): Promise<V> {
  const serverResponse = await _performApiRequest<T, V | IdTokenMfaResponse>(
    auth,
    method,
    path,
    request,
    customErrorMap
  );
  if ('mfaPendingCredential' in serverResponse) {
    throw AUTH_ERROR_FACTORY.create(AuthErrorCode.MFA_REQUIRED, {
      appName: auth.name,
      serverResponse
    });
  }

  return serverResponse;
}

function makeNetworkTimeout<T>(appName: string): Promise<T> {
  return new Promise((_, reject) =>
    setTimeout(() => {
      return reject(
        AUTH_ERROR_FACTORY.create(AuthErrorCode.TIMEOUT, {
          appName
        })
      );
    }, DEFAULT_API_TIMEOUT_MS.get())
  );
}

interface PotentialResponse extends IdTokenResponse {
  email?: string;
  phoneNumber?: string;
}

function makeTaggedError(
  { name }: AuthCore,
  code: AuthErrorCode,
  response: PotentialResponse
): FirebaseError {
  const errorParams: NamedErrorParams = {
    appName: name
  };

  if (response.email) {
    errorParams.email = response.email;
  }
  if (response.phoneNumber) {
    errorParams.phoneNumber = response.phoneNumber;
  }

  const error = AUTH_ERROR_FACTORY.create(code, errorParams);
  (error as TaggedWithTokenResponse)._tokenResponse = response;
  return error;
}
