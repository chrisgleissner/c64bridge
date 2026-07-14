/* eslint-disable */
/* tslint:disable */
/*
 * ---------------------------------------------------------------
 * ## THIS FILE WAS GENERATED VIA SWAGGER-TYPESCRIPT-API        ##
 * ##                                                           ##
 * ## AUTHOR: acacode                                           ##
 * ## SOURCE: https://github.com/acacode/swagger-typescript-api ##
 * ---------------------------------------------------------------
 */

export interface ErrorList {
  errors: string[];
}

export type VersionResponse = ErrorList & {
  /** @example "0.1" */
  version: string;
};

export type InfoResponse = ErrorList & {
  /** @example "Ultimate 64 Elite" */
  product: string;
  /** @example "3.15 alpha" */
  firmware_version: string;
  /** @example "122" */
  fpga_version: string;
  /**
   * Present on Ultimate 64-class firmware builds.
   * @example "1.4B"
   */
  core_version?: string;
  hostname: string;
  unique_id?: string;
};

export type ConfigCategoriesResponse = ErrorList & {
  categories: string[];
};

export type ConfigValue = string | number;

export interface ConfigItemDetail {
  current: ConfigValue;
  values?: string[];
  presets?: string[];
  min?: number;
  max?: number;
  format?: string;
  default?: ConfigValue;
  [key: string]: any;
}

export type ConfigCategoryResponse = ErrorList & Record<string, Record<string, ConfigValue | ConfigItemDetail>>;

/** @example {"Drive A Settings":{"Drive":"Enabled","Drive Bus ID":8}} */
export type ConfigBatchUpdate = Record<string, Record<string, ConfigValue>>;

export type ConfigStoreListResponse = ErrorList & {
  loaded?: string[];
  written?: string[];
  reset?: string[];
};

export type ActionResponse = ErrorList & Record<string, any>;

export interface DriveInfo {
  enabled?: boolean;
  bus_id?: number;
  type?: string;
  rom?: string;
  image_file?: string;
  image_path?: string;
  last_error?: string;
  partitions?: {
    id?: number;
    path?: string;
  }[];
  [key: string]: any;
}

export type DriveListResponse = ErrorList & {
  drives: Record<string, DriveInfo>[];
};

export type FileInfoResponse = ErrorList & {
  files: {
    path?: string;
    filename?: string;
    size?: number;
    extension?: string;
    [key: string]: any;
  };
};

export type InputStateResponse = ErrorList & {
  keyboard: {
    inputs: KeyboardInput[];
  };
  joysticks: {
    port: 1 | 2;
    inputs: JoystickInput[];
  }[];
};

export interface InputBatch {
  /**
   * @maxItems 64
   * @minItems 1
   */
  events: (KeyboardEvent | JoystickEvent | ReleaseAllEvent)[];
}

export interface KeyboardEvent {
  kind: any;
  /**
   * @maxItems 8
   * @minItems 1
   */
  inputs: KeyboardInput[];
  transition: InputTransition;
}

export interface JoystickEvent {
  kind: any;
  port: 1 | 2;
  /**
   * @maxItems 7
   * @minItems 1
   */
  inputs: JoystickInput[];
  transition: InputTransition;
}

export interface ReleaseAllEvent {
  kind: any;
}

export enum InputTransition {
  Press = "press",
  Release = "release",
  Tap = "tap",
}

export enum KeyboardInput {
  InstDel = "inst_del",
  Return = "return",
  CursorLeftRight = "cursor_left_right",
  F7 = "f7",
  F1 = "f1",
  F3 = "f3",
  F5 = "f5",
  CursorUpDown = "cursor_up_down",
  Value0 = "0",
  Value1 = "1",
  Value2 = "2",
  Value3 = "3",
  Value4 = "4",
  Value5 = "5",
  Value6 = "6",
  Value7 = "7",
  Value8 = "8",
  Value9 = "9",
  A = "a",
  B = "b",
  C = "c",
  D = "d",
  E = "e",
  F = "f",
  G = "g",
  H = "h",
  I = "i",
  J = "j",
  K = "k",
  L = "l",
  M = "m",
  N = "n",
  O = "o",
  P = "p",
  Q = "q",
  R = "r",
  S = "s",
  T = "t",
  U = "u",
  V = "v",
  W = "w",
  X = "x",
  Y = "y",
  Z = "z",
  LeftShift = "left_shift",
  RightShift = "right_shift",
  Plus = "plus",
  Minus = "minus",
  Period = "period",
  Colon = "colon",
  At = "at",
  Comma = "comma",
  Pound = "pound",
  Star = "star",
  Semicolon = "semicolon",
  ClrHome = "clr_home",
  Equals = "equals",
  ArrowUp = "arrow_up",
  Slash = "slash",
  ArrowLeft = "arrow_left",
  Ctrl = "ctrl",
  Space = "space",
  Commodore = "commodore",
  RunStop = "run_stop",
  Restore = "restore",
}

export enum JoystickInput {
  Up = "up",
  Down = "down",
  Left = "left",
  Right = "right",
  Fire = "fire",
  Fire2 = "fire2",
  Fire3 = "fire3",
}

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, HeadersDefaults, ResponseType } from "axios";

export type QueryParamsType = Record<string | number, any>;

export interface FullRequestParams extends Omit<AxiosRequestConfig, "data" | "params" | "url" | "responseType"> {
  /** set parameter to `true` for call `securityWorker` for this request */
  secure?: boolean;
  /** request path */
  path: string;
  /** content type of request body */
  type?: ContentType;
  /** query params */
  query?: QueryParamsType;
  /** format of response (i.e. response.json() -> format: "json") */
  format?: ResponseType;
  /** request body */
  body?: unknown;
}

export type RequestParams = Omit<FullRequestParams, "body" | "method" | "query" | "path">;

export interface ApiConfig<SecurityDataType = unknown> extends Omit<AxiosRequestConfig, "data" | "cancelToken"> {
  securityWorker?: (
    securityData: SecurityDataType | null,
  ) => Promise<AxiosRequestConfig | void> | AxiosRequestConfig | void;
  secure?: boolean;
  format?: ResponseType;
}

export enum ContentType {
  Json = "application/json",
  FormData = "multipart/form-data",
  UrlEncoded = "application/x-www-form-urlencoded",
  Text = "text/plain",
}

export class HttpClient<SecurityDataType = unknown> {
  public instance: AxiosInstance;
  private securityData: SecurityDataType | null = null;
  private securityWorker?: ApiConfig<SecurityDataType>["securityWorker"];
  private secure?: boolean;
  private format?: ResponseType;

  constructor({ securityWorker, secure, format, ...axiosConfig }: ApiConfig<SecurityDataType> = {}) {
    this.instance = axios.create({ ...axiosConfig, baseURL: axiosConfig.baseURL || "http://u64" });
    this.secure = secure;
    this.format = format;
    this.securityWorker = securityWorker;
  }

  public setSecurityData = (data: SecurityDataType | null) => {
    this.securityData = data;
  };

  protected mergeRequestParams(params1: AxiosRequestConfig, params2?: AxiosRequestConfig): AxiosRequestConfig {
    const method = params1.method || (params2 && params2.method);

    return {
      ...this.instance.defaults,
      ...params1,
      ...(params2 || {}),
      headers: {
        ...((method && this.instance.defaults.headers[method.toLowerCase() as keyof HeadersDefaults]) || {}),
        ...(params1.headers || {}),
        ...((params2 && params2.headers) || {}),
      },
    };
  }

  protected stringifyFormItem(formItem: unknown) {
    if (typeof formItem === "object" && formItem !== null) {
      return JSON.stringify(formItem);
    } else {
      return `${formItem}`;
    }
  }

  protected createFormData(input: Record<string, unknown>): FormData {
    return Object.keys(input || {}).reduce((formData, key) => {
      const property = input[key];
      const propertyContent: any[] = property instanceof Array ? property : [property];

      for (const formItem of propertyContent) {
        const isFileType = formItem instanceof Blob || formItem instanceof File;
        formData.append(key, isFileType ? formItem : this.stringifyFormItem(formItem));
      }

      return formData;
    }, new FormData());
  }

  public request = async <T = any, _E = any>({
    secure,
    path,
    type,
    query,
    format,
    body,
    ...params
  }: FullRequestParams): Promise<AxiosResponse<T>> => {
    const secureParams =
      ((typeof secure === "boolean" ? secure : this.secure) &&
        this.securityWorker &&
        (await this.securityWorker(this.securityData))) ||
      {};
    const requestParams = this.mergeRequestParams(params, secureParams);
    const responseFormat = format || this.format || undefined;

    if (type === ContentType.FormData && body && body !== null && typeof body === "object") {
      body = this.createFormData(body as Record<string, unknown>);
    }

    if (type === ContentType.Text && body && body !== null && typeof body !== "string") {
      body = JSON.stringify(body);
    }

    return this.instance.request({
      ...requestParams,
      headers: {
        ...(requestParams.headers || {}),
        ...(type && type !== ContentType.FormData ? { "Content-Type": type } : {}),
      },
      params: query,
      responseType: responseFormat,
      data: body,
      url: path,
    });
  };
}

/**
 * @title Ultimate 64 Elite REST API
 * @version 3.15-alpha
 * @baseUrl http://u64
 *
 * Source-derived OpenAPI description for the HTTP API implemented in
 * `/software/api` of the 1541ultimate firmware tree.
 *
 * The firmware exposes a single `v1` API version. JSON responses include an
 * `errors` array. Binary endpoints return `application/octet-stream` on
 * success and JSON with `errors` when the request cannot be completed.
 *
 * If a network password is configured on the device, every API request must
 * include the `X-Password` header. If no network password is configured, the
 * same endpoints are available without the header.
 */
export class Api<SecurityDataType extends unknown> {
  http: HttpClient<SecurityDataType>;

  constructor(http: HttpClient<SecurityDataType>) {
    this.http = http;
  }

  v1 = {
    /**
     * No description
     *
     * @tags System
     * @name GetHelp
     * @summary Return minimal HTML help for a command.
     * @request GET:/v1/help
     * @secure
     */
    getHelp: (
      query: {
        command: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<string, ErrorList>({
        path: `/v1/help`,
        method: "GET",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags System
     * @name GetApiVersion
     * @summary Get REST API version.
     * @request GET:/v1/version
     * @secure
     */
    getApiVersion: (params: RequestParams = {}) =>
      this.http.request<VersionResponse, ErrorList>({
        path: `/v1/version`,
        method: "GET",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags System
     * @name GetDeviceInfo
     * @summary Get device identity and firmware versions.
     * @request GET:/v1/info
     * @secure
     */
    getDeviceInfo: (params: RequestParams = {}) =>
      this.http.request<InfoResponse, ErrorList>({
        path: `/v1/info`,
        method: "GET",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags Runners
     * @name PlaySidFromFile
     * @summary Play a SID file already present on the device filesystem.
     * @request PUT:/v1/runners:sidplay
     * @secure
     */
    playSidFromFile: (
      sidplay: string,
      query: {
        /** Absolute or device-relative file path. */
        file: string;
        /**
         * @min 0
         * @default 0
         */
        songnr?: number;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/runners${sidplay}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Runners
     * @name PlayUploadedSid
     * @summary Upload and play a SID file.
     * @request POST:/v1/runners:sidplay
     * @secure
     */
    playUploadedSid: (
      sidplay: string,
      data: {
        /**
         * First file is the SID; optional second file is SID song-length data.
         * @maxItems 2
         * @minItems 1
         */
        file: File[];
      },
      query?: {
        /**
         * @min 0
         * @default 0
         */
        songnr?: number;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/runners${sidplay}`,
        method: "POST",
        query: query,
        body: data,
        secure: true,
        ...params,
      }),

    /**
     * @description Requires the FPGA sampler capability.
     *
     * @tags Runners
     * @name PlayModFromFile
     * @summary Play a MOD file from the device filesystem.
     * @request PUT:/v1/runners:modplay
     * @secure
     */
    playModFromFile: (
      modplay: string,
      query: {
        /** Absolute or device-relative file path. */
        file: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/runners${modplay}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * @description Requires the FPGA sampler capability.
     *
     * @tags Runners
     * @name PlayUploadedMod
     * @summary Upload and play a MOD file.
     * @request POST:/v1/runners:modplay
     * @secure
     */
    playUploadedMod: (
      modplay: string,
      data: {
        /** @format binary */
        file: File;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/runners${modplay}`,
        method: "POST",
        body: data,
        secure: true,
        type: ContentType.FormData,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Runners
     * @name LoadPrgFromFile
     * @summary Load a PRG from the device filesystem without starting it.
     * @request PUT:/v1/runners:load_prg
     * @secure
     */
    loadPrgFromFile: (
      loadPrg: string,
      query: {
        /** Absolute or device-relative file path. */
        file: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/runners${loadPrg}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Runners
     * @name LoadUploadedPrg
     * @summary Upload a PRG and load it without starting it.
     * @request POST:/v1/runners:load_prg
     * @secure
     */
    loadUploadedPrg: (
      loadPrg: string,
      data: {
        /** @format binary */
        file: File;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/runners${loadPrg}`,
        method: "POST",
        body: data,
        secure: true,
        type: ContentType.FormData,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Runners
     * @name RunPrgFromFile
     * @summary Load and run a PRG from the device filesystem.
     * @request PUT:/v1/runners:run_prg
     * @secure
     */
    runPrgFromFile: (
      runPrg: string,
      query: {
        /** Absolute or device-relative file path. */
        file: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/runners${runPrg}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Runners
     * @name RunUploadedPrg
     * @summary Upload, load, and run a PRG.
     * @request POST:/v1/runners:run_prg
     * @secure
     */
    runUploadedPrg: (
      runPrg: string,
      data: {
        /** @format binary */
        file: File;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/runners${runPrg}`,
        method: "POST",
        body: data,
        secure: true,
        type: ContentType.FormData,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Runners
     * @name RunCrtFromFile
     * @summary Load and start a CRT cartridge image from the device filesystem.
     * @request PUT:/v1/runners:run_crt
     * @secure
     */
    runCrtFromFile: (
      runCrt: string,
      query: {
        /** Absolute or device-relative file path. */
        file: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/runners${runCrt}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Runners
     * @name RunUploadedCrt
     * @summary Upload, load, and start a CRT cartridge image.
     * @request POST:/v1/runners:run_crt
     * @secure
     */
    runUploadedCrt: (
      runCrt: string,
      data: {
        /** @format binary */
        file: File;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/runners${runCrt}`,
        method: "POST",
        body: data,
        secure: true,
        type: ContentType.FormData,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Configuration
     * @name ListConfigCategories
     * @summary List configuration categories.
     * @request GET:/v1/configs
     * @secure
     */
    listConfigCategories: (params: RequestParams = {}) =>
      this.http.request<ConfigCategoriesResponse, ErrorList>({
        path: `/v1/configs`,
        method: "GET",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * @description Use single-item `PUT` for interactive writes; batch POST buffers the body on-device.
     *
     * @tags Configuration
     * @name BatchUpdateConfig
     * @summary Apply a JSON batch of configuration values.
     * @request POST:/v1/configs
     * @secure
     */
    batchUpdateConfig: (data: ConfigBatchUpdate, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/configs`,
        method: "POST",
        body: data,
        secure: true,
        type: ContentType.Json,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Configuration
     * @name GetConfigCategory
     * @summary Get matching configuration categories and their current values.
     * @request GET:/v1/configs/{category}
     * @secure
     */
    getConfigCategory: (category: string, params: RequestParams = {}) =>
      this.http.request<ConfigCategoryResponse, ErrorList>({
        path: `/v1/configs/${category}`,
        method: "GET",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags Configuration
     * @name GetConfigItem
     * @summary Get detailed metadata for matching configuration items.
     * @request GET:/v1/configs/{category}/{item}
     * @secure
     */
    getConfigItem: (category: string, item: string, params: RequestParams = {}) =>
      this.http.request<ConfigCategoryResponse, ErrorList>({
        path: `/v1/configs/${category}/${item}`,
        method: "GET",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags Configuration
     * @name UpdateConfigItem
     * @summary Update one configuration item using the `value` query parameter.
     * @request PUT:/v1/configs/{category}/{item}
     * @secure
     */
    updateConfigItem: (
      category: string,
      item: string,
      query: {
        value: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/configs/${category}/${item}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Configuration
     * @name UpdateConfigItemByPath
     * @summary Update one configuration item using the third path segment as the value.
     * @request PUT:/v1/configs/{category}/{item}/{setting}
     * @secure
     */
    updateConfigItemByPath: (category: string, item: string, setting: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/configs/${category}/${item}/${setting}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Configuration
     * @name LoadAllConfigsFromFlash
     * @summary Reload all configuration stores from flash.
     * @request PUT:/v1/configs:load_from_flash
     * @secure
     */
    loadAllConfigsFromFlash: (loadFromFlash: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/configs${loadFromFlash}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Configuration
     * @name LoadConfigCategoryFromFlash
     * @summary Reload matching configuration stores from flash.
     * @request PUT:/v1/configs/{category}:load_from_flash
     * @secure
     */
    loadConfigCategoryFromFlash: (category: string, loadFromFlash: string, params: RequestParams = {}) =>
      this.http.request<ConfigStoreListResponse, ErrorList>({
        path: `/v1/configs/${category}${loadFromFlash}`,
        method: "PUT",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags Configuration
     * @name SaveAllConfigsToFlash
     * @summary Save stale configuration stores to flash.
     * @request PUT:/v1/configs:save_to_flash
     * @secure
     */
    saveAllConfigsToFlash: (saveToFlash: string, params: RequestParams = {}) =>
      this.http.request<ConfigStoreListResponse, ErrorList>({
        path: `/v1/configs${saveToFlash}`,
        method: "PUT",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags Configuration
     * @name SaveConfigCategoryToFlash
     * @summary Save matching stale configuration stores to flash.
     * @request PUT:/v1/configs/{category}:save_to_flash
     * @secure
     */
    saveConfigCategoryToFlash: (category: string, saveToFlash: string, params: RequestParams = {}) =>
      this.http.request<ConfigStoreListResponse, ErrorList>({
        path: `/v1/configs/${category}${saveToFlash}`,
        method: "PUT",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags Configuration
     * @name ResetAllConfigsToDefault
     * @summary Reset all configuration stores to firmware defaults.
     * @request PUT:/v1/configs:reset_to_default
     * @secure
     */
    resetAllConfigsToDefault: (resetToDefault: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/configs${resetToDefault}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Configuration
     * @name ResetConfigCategoryToDefault
     * @summary Reset matching configuration stores to firmware defaults.
     * @request PUT:/v1/configs/{category}:reset_to_default
     * @secure
     */
    resetConfigCategoryToDefault: (category: string, resetToDefault: string, params: RequestParams = {}) =>
      this.http.request<ConfigStoreListResponse, ErrorList>({
        path: `/v1/configs/${category}${resetToDefault}`,
        method: "PUT",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name ResetMachine
     * @summary Reset the C64.
     * @request PUT:/v1/machine:reset
     * @secure
     */
    resetMachine: (reset: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/machine${reset}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name RebootMachine
     * @summary Reboot the C64.
     * @request PUT:/v1/machine:reboot
     * @secure
     */
    rebootMachine: (reboot: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/machine${reboot}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name PauseMachine
     * @summary Pause the machine using DMA.
     * @request PUT:/v1/machine:pause
     * @secure
     */
    pauseMachine: (pause: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/machine${pause}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name ResumeMachine
     * @summary Resume a paused machine.
     * @request PUT:/v1/machine:resume
     * @secure
     */
    resumeMachine: (resume: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/machine${resume}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name PowerOffMachine
     * @summary Request machine power off.
     * @request PUT:/v1/machine:poweroff
     * @secure
     */
    powerOffMachine: (poweroff: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/machine${poweroff}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name PressMenuButton
     * @summary Press the Ultimate menu button.
     * @request PUT:/v1/machine:menu_button
     * @secure
     */
    pressMenuButton: (menuButton: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/machine${menuButton}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name WriteMemoryHex
     * @summary Write up to 128 bytes of C64 memory from a hex string.
     * @request PUT:/v1/machine:writemem
     * @secure
     */
    writeMemoryHex: (
      writemem: string,
      query: {
        /**
         * C64 address in hexadecimal.
         * @pattern ^(0x)?[0-9A-Fa-f]{1,4}$
         */
        address: string;
        /** @pattern ^([0-9A-Fa-f]{2}){1,128}$ */
        data: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/machine${writemem}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name WriteMemoryUpload
     * @summary Write C64 memory from an uploaded binary payload.
     * @request POST:/v1/machine:writemem
     * @secure
     */
    writeMemoryUpload: (
      writemem: string,
      query: {
        /**
         * C64 address in hexadecimal.
         * @pattern ^(0x)?[0-9A-Fa-f]{1,4}$
         */
        address: string;
      },
      data: {
        /** @format binary */
        file: File;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/machine${writemem}`,
        method: "POST",
        query: query,
        body: data,
        secure: true,
        type: ContentType.FormData,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name ReadMemory
     * @summary Read C64 memory as raw bytes.
     * @request GET:/v1/machine:readmem
     * @secure
     */
    readMemory: (
      readmem: string,
      query: {
        /**
         * C64 address in hexadecimal.
         * @pattern ^(0x)?[0-9A-Fa-f]{1,4}$
         */
        address: string;
        /**
         * @min 0
         * @max 65536
         * @default 256
         */
        length?: number;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<File, ErrorList>({
        path: `/v1/machine${readmem}`,
        method: "GET",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * @description Returns 404 JSON when no active menu screen matrix is available.
     *
     * @tags Machine
     * @name ReadMenuScreen
     * @summary Read the active Ultimate menu screen matrix as raw bytes.
     * @request GET:/v1/machine:menu_screen
     * @secure
     */
    readMenuScreen: (menuScreen: string, params: RequestParams = {}) =>
      this.http.request<File, ErrorList>({
        path: `/v1/machine${menuScreen}`,
        method: "GET",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name ReadDebugRegister
     * @summary Read the Ultimate 64 debug register.
     * @request GET:/v1/machine:debugreg
     * @secure
     */
    readDebugRegister: (debugreg: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/machine${debugreg}`,
        method: "GET",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name WriteDebugRegister
     * @summary Write the Ultimate 64 debug register.
     * @request PUT:/v1/machine:debugreg
     * @secure
     */
    writeDebugRegister: (
      debugreg: string,
      query: {
        /** @pattern ^(0x)?[0-9A-Fa-f]{1,2}$ */
        value: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/machine${debugreg}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Machine
     * @name MeasureCartridgeBus
     * @summary Capture cartridge-bus timing as a VCD file.
     * @request GET:/v1/machine:measure
     * @secure
     */
    measureCartridgeBus: (measure: string, params: RequestParams = {}) =>
      this.http.request<File, ErrorList>({
        path: `/v1/machine${measure}`,
        method: "GET",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Input
     * @name GetInputState
     * @summary Read REST-injected keyboard and joystick state.
     * @request GET:/v1/machine:input
     * @secure
     */
    getInputState: (input: string, params: RequestParams = {}) =>
      this.http.request<InputStateResponse, ErrorList>({
        path: `/v1/machine${input}`,
        method: "GET",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags Input
     * @name SendInputEvents
     * @summary Apply keyboard and joystick input events.
     * @request POST:/v1/machine:input
     * @secure
     */
    sendInputEvents: (input: string, data: InputBatch, params: RequestParams = {}) =>
      this.http.request<InputStateResponse, ErrorList>({
        path: `/v1/machine${input}`,
        method: "POST",
        body: data,
        secure: true,
        type: ContentType.Json,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags Drives
     * @name ListDrives
     * @summary List internal drives and IEC service devices.
     * @request GET:/v1/drives
     * @secure
     */
    listDrives: (params: RequestParams = {}) =>
      this.http.request<DriveListResponse, ErrorList>({
        path: `/v1/drives`,
        method: "GET",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags Drives
     * @name MountDiskImage
     * @summary Mount a disk image from the device filesystem.
     * @request PUT:/v1/drives/{drive}:mount
     * @secure
     */
    mountDiskImage: (
      drive: "a" | "b",
      mount: string,
      query: {
        image: string;
        type?: "d64" | "g64" | "d71" | "g71" | "d81";
        mode?: "readwrite" | "readonly" | "unlinked";
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/drives/${drive}${mount}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Drives
     * @name MountUploadedDiskImage
     * @summary Upload and mount a disk image.
     * @request POST:/v1/drives/{drive}:mount
     * @secure
     */
    mountUploadedDiskImage: (
      drive: "a" | "b",
      mount: string,
      data: {
        /** @format binary */
        file: File;
      },
      query?: {
        type?: "d64" | "g64" | "d71" | "g71" | "d81";
        mode?: "readwrite" | "readonly" | "unlinked";
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/drives/${drive}${mount}`,
        method: "POST",
        query: query,
        body: data,
        secure: true,
        type: ContentType.FormData,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Drives
     * @name ResetDrive
     * @summary Reset a drive.
     * @request PUT:/v1/drives/{drive}:reset
     * @secure
     */
    resetDrive: (drive: "a" | "b", reset: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/drives/${drive}${reset}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Drives
     * @name RemoveMountedImage
     * @summary Remove the mounted image from a drive.
     * @request PUT:/v1/drives/{drive}:remove
     * @secure
     */
    removeMountedImage: (drive: "a" | "b", remove: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/drives/${drive}${remove}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Drives
     * @name PowerOnDrive
     * @summary Power on a drive.
     * @request PUT:/v1/drives/{drive}:on
     * @secure
     */
    powerOnDrive: (drive: "a" | "b", on: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/drives/${drive}${on}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Drives
     * @name PowerOffDrive
     * @summary Power off a drive.
     * @request PUT:/v1/drives/{drive}:off
     * @secure
     */
    powerOffDrive: (drive: "a" | "b", off: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/drives/${drive}${off}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Drives
     * @name UnlinkMountedImage
     * @summary Unlink the mounted image from host storage.
     * @request PUT:/v1/drives/{drive}:unlink
     * @secure
     */
    unlinkMountedImage: (drive: "a" | "b", unlink: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/drives/${drive}${unlink}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Drives
     * @name LoadDriveRomFromFile
     * @summary Load a drive ROM from the device filesystem.
     * @request PUT:/v1/drives/{drive}:load_rom
     * @secure
     */
    loadDriveRomFromFile: (
      drive: "a" | "b",
      loadRom: string,
      query: {
        /** Absolute or device-relative file path. */
        file: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/drives/${drive}${loadRom}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Drives
     * @name LoadUploadedDriveRom
     * @summary Upload and load a drive ROM.
     * @request POST:/v1/drives/{drive}:load_rom
     * @secure
     */
    loadUploadedDriveRom: (
      drive: "a" | "b",
      loadRom: string,
      data: {
        /** @format binary */
        file: File;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/drives/${drive}${loadRom}`,
        method: "POST",
        body: data,
        secure: true,
        type: ContentType.FormData,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Drives
     * @name SetDriveMode
     * @summary Set drive emulation mode.
     * @request PUT:/v1/drives/{drive}:set_mode
     * @secure
     */
    setDriveMode: (
      drive: "a" | "b",
      setMode: string,
      query: {
        mode: "1541" | "1571" | "1581";
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/drives/${drive}${setMode}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Streams
     * @name StartDataStream
     * @summary Start a data stream.
     * @request PUT:/v1/streams/{stream}:start
     * @secure
     */
    startDataStream: (
      stream: "video" | "audio" | "debug",
      start: string,
      query: {
        /** Destination IPv4 address, optionally with port. */
        ip: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/streams/${stream}${start}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Streams
     * @name StopDataStream
     * @summary Stop a data stream.
     * @request PUT:/v1/streams/{stream}:stop
     * @secure
     */
    stopDataStream: (stream: "video" | "audio" | "debug", stop: string, params: RequestParams = {}) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/streams/${stream}${stop}`,
        method: "PUT",
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Files
     * @name GetFileInfo
     * @summary Get metadata for a device filesystem path.
     * @request GET:/v1/files/{path}:info
     * @secure
     */
    getFileInfo: (path: string, info: string, params: RequestParams = {}) =>
      this.http.request<FileInfoResponse, ErrorList>({
        path: `/v1/files/${path}${info}`,
        method: "GET",
        secure: true,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags Files
     * @name CreateD64
     * @summary Create and format a D64 image.
     * @request PUT:/v1/files/{path}:create_d64
     * @secure
     */
    createD64: (
      path: string,
      createD64: string,
      query?: {
        /**
         * @min 35
         * @max 41
         * @default 35
         */
        tracks?: number;
        diskname?: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/files/${path}${createD64}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Files
     * @name CreateD71
     * @summary Create and format a D71 image.
     * @request PUT:/v1/files/{path}:create_d71
     * @secure
     */
    createD71: (
      path: string,
      createD71: string,
      query?: {
        diskname?: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/files/${path}${createD71}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Files
     * @name CreateD81
     * @summary Create and format a D81 image.
     * @request PUT:/v1/files/{path}:create_d81
     * @secure
     */
    createD81: (
      path: string,
      createD81: string,
      query?: {
        diskname?: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/files/${path}${createD81}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),

    /**
     * No description
     *
     * @tags Files
     * @name CreateDnp
     * @summary Create and format a DNP image.
     * @request PUT:/v1/files/{path}:create_dnp
     * @secure
     */
    createDnp: (
      path: string,
      createDnp: string,
      query: {
        /**
         * @min 1
         * @max 255
         */
        tracks: number;
        diskname?: string;
      },
      params: RequestParams = {},
    ) =>
      this.http.request<ActionResponse, ErrorList>({
        path: `/v1/files/${path}${createDnp}`,
        method: "PUT",
        query: query,
        secure: true,
        ...params,
      }),
  };
}
