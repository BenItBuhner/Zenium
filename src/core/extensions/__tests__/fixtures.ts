/**
 * Real-world CRX3 prelude + header bytes (no archive), base64-encoded, captured from the stores on
 * 2026-09-17. Enough to test header parsing, id derivation and publisher-key identification
 * offline; signatures cannot be verified without the archive.
 */

/** Vimium 2.4.2 from the Chrome Web Store: 1048-byte header, RSA-1024 developer key. */
export const CWS_VIMIUM_HEADER_BASE64 =
  'Q3IyNAMAAAAYBAAAEqwECqYCMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAj/u/XDdjlDyw7gHEtaaasZ9GdG8W' +
  'OKAyJzXd8HFrDtz2Jcuy7er7MtWvHgNDA0bwpznbI5YdZeV4UfCEsA4SrA5b3MnWTHwA1bgbiDM+L9rrqvcadcKuOlTeN48Q' +
  '0ijmhHlNFbTzvT9W0zw/GKv8LgXAHggxtmHQ/Z9PP2QNF5O8rUHHSL4AJ6hNcEKSBVSmbbjeVm4gSXDuED5r0nwxvRtupDxG' +
  'Yp8IZpP5KlExqNu1nbkPc+igCTIB6XsqijagzxewUHCdovmkb2JNtskx/PMIEv+TvWIx2BzqGp71gSh/dV7SJ3rClvWd2xj8' +
  'dtxG8FfAWDTIIi0qZXWn2QhizQIDAQABEoACX2M7UoP/dmZh92yPimMZvZR3zdXa9t+2iW9IxuAHJ+oOMWONEs9C+66lFvgQ' +
  'juLTgvZQgfU+TQFeGqo0bbe5Jex5hfA8gNrWpIf0yYuDy8hTugwa7qtydRpSAbI+ncExxhiYdL640xxmNLvooeyb8GEUfJlA' +
  'FnCyctszgcmwFoil5d6GhU3OUcwUYYIwTL4vwXn/Yb+DW4D5PmtF/Xo5mA0Dqtdo7A1vVHKQ/vMUOOmsFXMCJen1QehWjedf' +
  'vfxeuBBrRLfAvEAtfi6MwJmEJRGIroeGZ59bu9PDp+dM4wSFOjOp7SUhmnjGm/FVNC/Q6lvgYfI3o0P3CBB1n7Jm9hKoAgqi' +
  'ATCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAmr4swmfRJwRm7XEZjBK3GsQ9llByfTBPCGBkIVAZRYCL3ISYwDvJKMmp' +
  'NwDPeXart7Di3bSGA/u+U/NldVpeXy5xwHoo9vyFi9lVYkx3mYV2Zdfqw/bEQ2hGHe2mXraSdvfl134VaYSgKwgn8G2AraCY' +
  'UyK+kug2LF7kXr6FdBMCAwEAARKAAXGMclL0/8My6n4MQLZ59CZKLzCoXchPM/o8+kAEnh8QjPAJpyUU0spfEVPKf4uTVd+h' +
  'GU06u8oFFmgH1NKhLRUG+f4SOvoETR/LrY3SlkqoEYquAYmDw6S5zRSZ14QgNE7nwG+ZHMA0QWOXgYkNfbyzgMzHNx6W20b6' +
  '5lHMGD/GGqUBClswWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAS0AvmpHK7hDIT43JsXcpil4DLV2ytZ2EnA777oa/n4YlK4' +
  'ajVTbAeLONT/mt283fm8SCJpzC1soQFgtFHje9HPEkYwRAIgDexp9D8i5+Tlv77SjUm2e4mgFUrKnfg9b5TsXsl9J04CIAOx' +
  'MwlGa3h/QCUYNuBzmJL9uQ8roYGIbX+pvwORlNS1gvEEEgoQMU9mTmEIF2130+n0+IcsQQ=='
export const CWS_VIMIUM_ID = 'dbepggeogbaibhgnhhndojpepiihcmeb'

/** ClearURLs 1.27.3 from Edge Add-ons: 1310-byte header, RSA-2048 developer key. */
export const EDGE_CLEARURLS_HEADER_BASE64 =
  'Q3IyNAMAAAAeBQAAEqwECqYCMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArl5ab8/zRbEME+U397mZAkXNYv3b' +
  'LDmUrhTIURXsL7zWIbrFIWLm8etVSVUiK8vBo0QiFCFn8eoxdSmuCiZy1GKuqtwD5oDooXUplMCfuiOzXPA4d2UcUrZEk4AI' +
  'xTnBMYTJGYtZub/sFd88eWjKyYKQFzIp919yjZ6q/N7MYXm63GAotQ5bOzXVXW0NFMXna8ILQiZL32TjNKGHj93jiXitXDAU' +
  'BDnm0b3JejfZhHsVZnQR0XoKDM9HHvwOPy1DrexzmQa95T3pLyEPR6MhGZAysS2buStxcMLFCG8AS0OUzmPWbUnrF2LoARMn' +
  '9GJVUsd7+ZUxCDbDZBFmMaEY2QIDAQABEoACnWdawo/VsN23WRqMAGmSXjf5nWrzP3AroBRXlNqIoGDd88vfrYyLPUSnr2bT' +
  'wb3pXcHgHErnAdonJM5i8KW/X54T6PutczcDlqFoY79rvr0woVsX5YApSXRzboOSMXTVZQ1LXuyoFzmH3FW8mR3eUDYfRgul' +
  'ZuA4a7Q7J+BuWaUUyeKt4KZc9UiFMdJjd7b6Pw/vJZiDB2n+MzXxOr/OqmcAh1Le3EOkXXeNW5s6LNTyCbtPHCWpqihbwOWG' +
  'o9fSEDfaRdbRenXCZZXHreKuNjy6xtS47wm8EiMUWZobMaa8oyz80b/8QZKrMLpam2OTuLSdvLfTjUu4R8LUQG5SXBKsBAqm' +
  'AjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALpeU1VkJVG/TF2f4JGy7gjZQ2wybxLkBFxbxQft0sknKryJrztS' +
  'PebN7brCTqlDNefvrov1G2S5IB257QPCStFDPnXBa3LzxphZvI9zeUpD8FhTnnG7jUW1bj+z7v0SKEeANYLchikypUeiwpch' +
  '5KawTRlTU5J7wqOMVYoAuR0h10VFxM9NW6QjcXP3QZkxheasz2cpblHKY8apokfWmdoNq0JkAdI3FQrMvyDcT95CSd/kS1hR' +
  'HN40h2SFS5owseqA3OTWCWeF562fg4fkuC1wiN3Q8VrSRXv36aHlTSbVrH5u4lRFN/MDezAbCJvZNQQjmkMrM9eNeSlwZDnu' +
  'ZQ8CAwEAARKAAifTQT7Ah9QU0+BQuv4elCLGeNp1w0GpnsyKxOTfxwQzHAvF898CmIPeZif4IcJ+k0XKzZgJVhiam0zfd5zB' +
  'KybuSaeiCU+Mbaleb0RQUZA3oHcddQ1di+LO73OFV+3M0F+9BQH5qNUekqHS/iMVIXNwiZJZsnz5ncDeZaDAxrocR83hI8RD' +
  'siiZC6aw3c0tVCx0JbNyes0L0HR2MMqiLR4Mf2FMdTNuNjqxpy8oNHCWYc9vAuNK305Z9RZecxoTSmCUfZqjE5dKLsYhC45i' +
  'aKM8rvONywi+jAir8PGEhDcFQM9G3dlr/u8EPoouVjjJWWce+WRdnqy17/EVqx1+h5capwEKWzBZMBMGByqGSM49AgEGCCqG' +
  'SM49AwEHA0IABAGIYC4Q34srlpitP0Cu4xYyNpj2Qf24Lk6972NkXwXJ5U0t0yoRH9iaBqNJ4skYJjyAmAYALqMMuO1ZCpnb' +
  'qiUSSDBGAiEAr82B6TzENF0JOKXHiFAfC94ue2kneWq3LR7E/5u++lUCIQC1E8SfNP/KU87TSZDEko506+Ik72nFDJDSvXX0' +
  '+rie/ILxBBIKEMOjwIKqU0oZPulQvxpgM0g='
export const EDGE_CLEARURLS_ID = 'mdkdmaickkfdekbjdoojfalpbkgaddei'
