declare module 'registry-js' {
  export type RegistryValue = {
    readonly name: string;
    readonly type: string;
    readonly data: string | number;
  };

  export const HKEY: {
    readonly HKEY_CURRENT_USER: string;
  };

  export const RegistryValueType: {
    readonly REG_SZ: string;
  };

  export function setValue(
    key: string,
    subkey: string,
    valueName: string,
    valueType: string,
    valueData: string,
  ): boolean;

  export const createKey: ((key: string, subkey: string) => boolean) | undefined;

  export function enumerateValues(key: string, subkey: string): ReadonlyArray<RegistryValue>;

  export const deleteValue: ((key: string, subkey: string, valueName: string) => boolean) | undefined;
}
