/**
 * Per-site password rules from Apple's password-manager-resources (quirks/password-rules.json),
 * MIT licensed, https://github.com/apple/password-manager-resources, snapshot of commit
 * 0c47ded584856df830850079ac775bef9fe4ece1. Keys are hostnames, values the rule strings as
 * published; `rules.ts` parses them. Refresh by converting the upstream JSON to this object.
 */
export const PASSWORD_RULES: Record<string, string> = {
  '163.com': 'minlength: 6; maxlength: 16;',
  '1800flowers.com': 'minlength: 6; required: lower, upper; required: digit;',
  'access.service.gov.uk':
    'minlength: 10; required: lower; required: upper; required: digit; required: special;',
  'account.samsung.com':
    'minlength: 8; maxlength: 15; max-consecutive: 3; required: digit; required: special; required: upper,lower;',
  'account.xiaomi.com': 'minlength: 8; maxlength: 16; required: digit; required: upper,lower;',
  'acmemarkets.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'act.org':
    'minlength: 8; maxlength: 64; required: lower; required: upper; required: digit; required: [!#$%&*@^];',
  'activision.com':
    'minlength: 8; maxlength: 20; max-consecutive: 2; required: lower, upper; required: digit;',
  'admiral.com':
    'minlength: 8; required: digit; required: [- !"#$&\'()*+,.:;<=>?@[^_`{|}~]]; allowed: lower, upper;',
  'ae.com': 'minlength: 8; maxlength: 25; required: lower; required: upper; required: digit;',
  'aeon.co.jp':
    'minlength: 8; maxlength: 8; max-consecutive: 3; required: digit; required: upper,lower,[#$+./:=?@[^_|~]];',
  'aeromexico.com':
    'minlength: 8; maxlength: 25; required: lower; required: upper; required: digit;',
  'aesop.com':
    'minlength: 8; maxlength: 25; required: lower; required: upper; required: digit; required: [!@#$%&?];',
  'aetna.com':
    'minlength: 8; maxlength: 20; max-consecutive: 2; required: upper; required: digit; allowed: lower, [-_&#@];',
  'airasia.com': 'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit;',
  'airfrance.com':
    'minlength: 8; maxlength: 12; required: lower; required: upper; required: digit; allowed: [-!#$&+/?@_];',
  'airfrance.us':
    'minlength: 8; maxlength: 12; required: lower; required: upper; required: digit; allowed: [-!#$&+/?@_];',
  'ajisushionline.com':
    'minlength: 8; required: lower; required: upper; required: digit; allowed: [ !#$%&*?@];',
  'albertsons.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'alelo.com.br': 'minlength: 6; maxlength: 10; required: lower; required: upper; required: digit;',
  'aliexpress.com': 'minlength: 6; maxlength: 20; allowed: lower, upper, digit;',
  'alliantcreditunion.com':
    'minlength: 8; maxlength: 20; max-consecutive: 3; required: lower, upper; required: digit; allowed: [!#$*];',
  'allianz.com.br': 'minlength: 4; maxlength: 4;',
  'americanexpress.com':
    'minlength: 8; maxlength: 20; max-consecutive: 4; required: lower, upper; required: digit; allowed: [%&_?#=];',
  'amnh.org':
    'minlength: 8; maxlength: 16; required: digit; required: upper,lower; allowed: ascii-printable;',
  'amundi-ee.com': 'minlength: 6; maxlength: 6; allowed: digit; max-consecutive: 3;',
  'ana.co.jp': 'minlength: 8; maxlength: 16; required: digit; required: upper,lower;',
  'anatel.gov.br': 'minlength: 6; maxlength: 15; allowed: lower, upper, digit;',
  'ancestry.com': 'minlength: 8; required: lower, upper; required: digit;',
  'andronicos.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'angieslist.com': 'minlength: 6; maxlength: 15;',
  'anthem.com':
    'minlength: 8; maxlength: 20; max-consecutive: 3; required: lower, upper; required: digit; allowed: [!$*?@|];',
  'app.digiboxx.com':
    'minlength: 8; maxlength: 14; required: lower; required: upper; required: digit; required: [@$!%*?&];',
  'app.digio.in': 'minlength: 8; maxlength: 15;',
  'app.parkmobile.io':
    'minlength: 8; maxlength: 25; required: lower; required: upper; required: digit; required: [!@#$%^&];',
  'app8menu.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [@$!%*?&];',
  'apple.com':
    'minlength: 8; maxlength: 63; required: lower; required: upper; required: digit; allowed: ascii-printable;',
  'appleloan.citizensbank.com':
    'minlength: 10; maxlength: 20; max-consecutive: 2; required: lower; required: upper; required: digit; required: [!#$%@^_];',
  'aqara.com': 'minlength: 8; maxlength: 16; required: upper,lower; required: digit,special;',
  'areariservata.bancaetica.it':
    'minlength: 8; maxlength: 10; required: lower; required: upper; required: digit; required: [!#&*+/=@_];',
  'artscyclery.com': 'minlength: 6; maxlength: 19;',
  'asahi-net.or.jp': 'minlength: 6; maxlength: 15; required: lower; required: digit;',
  'astonmartinf1.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; allowed: special;',
  'auth.readymag.com':
    'minlength: 8; maxlength: 128; required: lower; required: upper; allowed: special;',
  'auth.zennioptical.com':
    'minlength: 8; maxlength: 14; required: lower; required: upper; required: digit; allowed: special;',
  'autify.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!"#$%&\'()*+,./:;<=>?@[^_`{|}~]];',
  'axa.de':
    'minlength: 8; maxlength: 65; required: lower; required: upper; required: digit; allowed: [-!"§$%&/()=?;:_+*\'#];',
  'baidu.com': 'minlength: 6; maxlength: 14;',
  'balduccis.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'bancochile.cl': 'minlength: 8; maxlength: 8; required: lower; required: upper; required: digit;',
  'bankofamerica.com':
    'minlength: 8; maxlength: 20; max-consecutive: 3; required: lower; required: upper; required: digit; allowed: [-@#*()+={}/?~;,._];',
  'battle.net': 'minlength: 8; maxlength: 16; required: lower, upper; allowed: digit, special;',
  'bcassessment.ca': 'minlength: 8; maxlength: 14;',
  'belkin.com': 'minlength: 8; required: lower, upper; required: digit; required: [$!@~_,%&];',
  'benefitslogin.discoverybenefits.com':
    'minlength: 10; required: upper; required: digit; required: [!#$%&*?@]; allowed: lower;',
  'benjerry.com':
    'required: upper; required: upper; required: digit; required: digit; required: special; required: special; allowed: lower;',
  'bestbuy.com':
    'minlength: 20; required: lower; required: upper; required: digit; required: special;',
  'bhphotovideo.com': 'maxlength: 15;',
  'bilibili.com': 'maxlength: 16;',
  'billerweb.com': 'minlength: 8; max-consecutive: 2; required: digit; required: upper,lower;',
  'biovea.com': 'maxlength: 19;',
  'bitly.com':
    'minlength: 6; required: lower; required: upper; required: digit; required: [`!@#$%^&*()+~{}\'";:<>?]];',
  'bkvenergy.com':
    'minlength: 8; maxlength: 12; required: upper; required: lower; required: digit; required: [-~!@#$%^&*()_=+,<.> ];',
  'blackwells.co.uk': 'minlength: 8; maxlength: 30; allowed: upper,lower,digit;',
  'bloomingdales.com':
    'minlength: 7; maxlength: 16; required: lower, upper; required: digit; required: [`!@#$%^&*()+~{}\'";:<>?]];',
  'bluesguitarunleashed.com': 'allowed: lower, upper, digit, [!$#@];',
  'bochk.com':
    'minlength: 8; maxlength: 12; max-consecutive: 3; required: lower; required: upper; required: digit; allowed: [#$%&()*+,.:;<=>?@_];',
  'box.com':
    'minlength: 6; maxlength: 20; required: lower; required: upper; required: digit; required: digit;',
  'bpl.bibliocommons.com': 'minlength: 4; maxlength: 4; required: digit;',
  'brighthorizons.com': 'minlength: 8; maxlength: 16;',
  'callofduty.com':
    'minlength: 8; maxlength: 20; max-consecutive: 2; required: lower, upper; required: digit;',
  'candyrect.com':
    'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit;',
  'capitalone.com':
    'minlength: 8; maxlength: 32; required: lower, upper; required: digit; allowed: [-_./\\@$*&!#];',
  'cardbenefitservices.com':
    'minlength: 7; maxlength: 100; required: lower, upper; required: digit;',
  'cardcash.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!$%&*?@];',
  'carmax.com':
    "minlength: 8; maxlength: 64; required: upper,lower; required: digit; allowed: [@$!%*#?&^'_+=;:,.~/\\|{}()[\\]];",
  'carrefour.it':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&*?@_];',
  'carrsqc.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'carte-mobilite-inclusion.fr':
    'minlength: 12; maxlength: 30; required: lower; required: upper; required: digit;',
  'cathaypacific.com':
    'minlength: 8; maxlength: 20; required: upper; required: digit; required: [!#$*^]; allowed: lower;',
  'cb2.com': 'minlength: 9; required: lower, upper; required: digit; required: [!#*_%.$];',
  'ccs-grp.com':
    "minlength: 8; maxlength: 16; required: digit; required: upper,lower; allowed: [-!#$%&'+./=?\\^_`{|}~];",
  'cecredentialtrust.com':
    'minlength: 12; required: lower; required: upper; required: digit; required: [!#$%&*@^];',
  'charlie.mbta.com':
    'minlength: 10; required: lower; required: upper; required: digit; required: [!#$%@^];',
  'chase.com':
    'minlength: 8; maxlength: 32; max-consecutive: 2; required: lower, upper; required: digit; required: [!#$%+/=@~];',
  'cigna.co.uk': 'minlength: 8; maxlength: 12; required: lower; required: upper; required: digit;',
  'citi.com':
    'minlength: 8; maxlength: 64; max-consecutive: 2; required: digit; required: upper; required: lower; required: [-~`!@#$%^&*()_\\/|];',
  'claimlookup.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: [@#$%^&+=!];',
  'clarksoneyecare.com':
    'minlength: 9; allowed: lower; required: upper; required: digit; required: [~!@#$%^&*()_+{}|;,.<>?[]];',
  'claro.com.br': 'minlength: 8; required: lower; allowed: upper, digit, [-!@#$%&*_+=<>];',
  'classmates.com': 'minlength: 6; maxlength: 20; allowed: lower, upper, digit, [!@#$%^&*];',
  'clegc-gckey.gc.ca': 'minlength: 8; maxlength: 16; required: lower, upper, digit;',
  'clien.net': 'minlength: 5; required: lower, upper; required: digit;',
  'clippercard.com':
    'minlength: 8; maxlength: 30; required: upper; required: lower; required: digit; required: [!@#$%^*?_&~];',
  'cogmembers.org':
    'minlength: 8; maxlength: 14; required: upper; required: digit; allowed: lower;',
  'collectivehealth.com': 'minlength: 8; required: lower; required: upper; required: digit;',
  'comcastpaymentcenter.com':
    'minlength: 8; maxlength: 20; max-consecutive: 2;required: lower, upper; required: digit;',
  'comed.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; allowed: [-~!@#$%^&*_+=`|(){}[:;"\'<>,.?/\\]];',
  'commerzbank.de': 'minlength: 5; maxlength: 8; required: lower, upper; required: digit;',
  'consorsbank.de': 'minlength: 5; maxlength: 5; required: lower, upper, digit;',
  'consorsfinanz.de': 'minlength: 6; maxlength: 15; allowed: lower, upper, digit, [-.];',
  'consular.mfa.gov.cn':
    'minlength: 9; maxlength: 16; required: digit; required: [!@#$^*]; allowed: lower, upper;',
  'costco.com':
    "minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: [-!#$%&'()*+/:;=?@[^_`{|}~]];",
  'coursera.com': 'minlength: 8; maxlength: 72;',
  'cox.com':
    'minlength: 8; maxlength: 24; required: digit; required: upper,lower; allowed: [!#$%()*@^];',
  'crateandbarrel.com':
    'minlength: 9; maxlength: 64; required: lower; required: upper; required: digit; required: [!"#$%&()*,.:<>?@^_{|}];',
  'crowdgen.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: [!#$%&()*+=@^_];',
  'cvs.com':
    'minlength: 8; maxlength: 25; required: lower, upper; required: digit; required: [!@#$%^&*()];',
  'dailymail.co.uk': 'minlength: 5; maxlength: 15;',
  'dan.org':
    'minlength: 8; maxlength: 25; required: lower; required: upper; required: digit; required: [!@$%^&*];',
  'danawa.com':
    'minlength: 8; maxlength: 21; required: lower, upper; required: digit; required: [!@$%^&*];',
  'darty.com': 'minlength: 8; required: lower; required: upper; required: digit;',
  'dbs.com.hk': 'minlength: 8; maxlength: 30; required: lower; required: upper; required: digit;',
  'decluttr.com': 'minlength: 8; maxlength: 45; required: lower; required: upper; required: digit;',
  'delta.com': 'minlength: 8; maxlength: 20; required: lower; required: upper; required: digit;',
  'deutsche-bank.de': 'minlength: 5; maxlength: 5; required: lower, upper, digit;',
  'devstore.cn': 'minlength: 6; maxlength: 12;',
  'dickssportinggoods.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&*?@^];',
  'dkb.de':
    'minlength: 8; maxlength: 38; required: lower, upper; required: digit; allowed: [-äüöÄÜÖß!$%&/()=?+#,.:];',
  'dmm.com': 'minlength: 4; maxlength: 16; required: lower; required: upper; required: digit;',
  'dodgeridge.com':
    'minlength: 8; maxlength: 12; required: lower; required: upper; required: digit;',
  'dowjones.com': 'maxlength: 15;',
  'ea.com':
    'minlength: 8; maxlength: 64; required: lower; required: upper; required: digit; allowed: special;',
  'easycoop.com': 'minlength: 8; required: upper; required: special; allowed: lower, digit;',
  'easyjet.com':
    'minlength: 6; maxlength: 20; required: lower; required: upper; required: digit; required: [-];',
  'ebrap.org':
    'minlength: 15; required: lower; required: lower; required: upper; required: upper; required: digit; required: digit; required: [-!@#$%^&*()_+|~=`{}[:";\'?,./.]]; required: [-!@#$%^&*()_+|~=`{}[:";\'?,./.]];',
  'ecompanystore.com':
    'minlength: 8; maxlength: 16; max-consecutive: 2; required: lower; required: upper; required: digit; required: [#$%*+.=@^_];',
  'eddservices.edd.ca.gov':
    'minlength: 8; maxlength: 12; required: lower; required: upper; required: digit; required: [!@#$%^&*()];',
  'edistrict.kerala.gov.in':
    'minlength: 5; maxlength: 15; required: lower; required: upper; required: digit; required: [!@#$];',
  'eki-net.com': 'minlength: 6; maxlength: 12; required: digit; required: upper,lower;',
  'empower-retirement.com': 'minlength: 8; maxlength: 16;',
  'epicgames.com':
    'minlength: 7; required: lower; required: upper; required: digit; required: [-!"#$%&\'()*+,./:;<=>?@[^_`{|}~]];',
  'epicmix.com': 'minlength: 8; maxlength: 16;',
  'equifax.com':
    'minlength: 8; maxlength: 20; required: lower; required: upper; required: digit; required: [!$*+@];',
  'essportal.excelityglobal.com': 'minlength: 6; maxlength: 8; allowed: lower, upper, digit;',
  'ettoday.net': 'minlength: 6; maxlength: 12;',
  'examservice.com.tw': 'minlength: 6; maxlength: 8;',
  'expertflyer.com': 'minlength: 5; maxlength: 16; required: lower, upper; required: digit;',
  'extraspace.com':
    'minlength: 8; maxlength: 20; allowed: lower; required: upper, digit, [!#$%&*?@];',
  'ezpassva.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: special;',
  'fc2.com': 'minlength: 8; maxlength: 16; allowed: upper, lower, digit;',
  'fccaccessonline.com':
    'minlength: 8; maxlength: 14; max-consecutive: 3; required: lower; required: upper; required: digit; required: [!#$%*^_];',
  'fedex.com':
    'minlength: 8; max-consecutive: 3; required: lower; required: upper; required: digit; allowed: [-!@#$%^&*_+=`|(){}[:;,.?]];',
  'fidelity.com':
    "minlength: 8; maxlength: 20; required: lower; required: upper; required: digit; required: [-!$%'()+,./:;=?@\\^_|~];",
  'flyertalk.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [-@#_$%^&!~?*];',
  'flysas.com':
    'minlength: 8; maxlength: 14; required: lower; required: upper; required: digit; required: [-~!@#$%^&_+=`|(){}[:"\'<>,.?]];',
  'fnac.com': 'minlength: 8; required: lower; required: upper; required: digit;',
  'fuelrewards.com': 'minlength: 8; maxlength: 16; allowed: upper,lower,digit,[!#$%@];',
  'gamestop.com':
    'minlength: 8; maxlength: 225; required: lower; required: upper; required: digit; required: [!@#$%];',
  'gap.com':
    'minlength: 8; maxlength: 24; required: lower; required: upper; required: digit; required: [-!@#$%^&*()_+];',
  'garmin.com': 'minlength: 8; required: lower; required: upper; required: digit;',
  'getflywheel.com': 'minlength: 7; maxlength: 72;',
  'girlscouts.org':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; allowed: [$#!];',
  'globo.com': 'minlength: 8; maxlength: 15;',
  'gmx.net':
    'minlength: 8; maxlength: 40; allowed: lower, upper, digit, [-<=>~!|()@#{}$%,.?^\'&*_+`:;"[]];',
  'gocurb.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [$%&#*?!@^];',
  'google.com': 'minlength: 8; allowed: lower, upper, digit, [-!"#$%&\'()*+,./:;<=>?@[^_{|}~]];',
  'guardiananytime.com':
    'minlength: 8; maxlength: 50; max-consecutive: 2; required: lower; required: upper; required: digit, [-~!@#$%^&*_+=`|(){}[:;,.?]];',
  'gwl.greatwestlife.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [-!#$%_=+<>];',
  'haggen.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'hangseng.com': 'minlength: 8; maxlength: 30; required: lower; required: upper; required: digit;',
  'hawaiianairlines.com': 'maxlength: 16;',
  'hdfc.bank.in':
    'minlength: 8; maxlength: 15; required: digit; required: upper, lower; allowed: [@&:|.^~#_$!)?];',
  'hdfcbank.com':
    'minlength: 8; maxlength: 15; required: digit; required: upper, lower; allowed: [@&:|.^~#_$!)?];',
  'hertz-japan.com':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz-kuwait.com':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz-saudi.com':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.at':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.be':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.bh':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.ca':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.ch':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.cn':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.co.ao':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.co.id':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.co.kr':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.co.nz':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.co.th':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.co.uk':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.com':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.com.au':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.com.bh':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.com.hk':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.com.kw':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.com.mt':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.com.pl':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.com.pt':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.com.sg':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.com.tw':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.cv':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.cz':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.de':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.ee':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.es':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.fi':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.fr':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.hu':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.ie':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.it':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.jo':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.lt':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.nl':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.no':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.nu':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.pl':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.pt':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.qa':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.ru':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.se':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertz.si':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hertzcaribbean.com':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower; required: upper; required: digit; required: [#$%^&!@];',
  'hetzner.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [-^!$%/()=?+#.,;:~*@{}_&[]];',
  'hilton.com': 'minlength: 8; maxlength: 32; required: lower; required: upper; required: digit;',
  'hkbea.com': 'minlength: 8; maxlength: 12; required: lower; required: upper; required: digit;',
  'hkexpress.com':
    'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit; required: special;',
  'home.cards.citidirect.com':
    'minlength: 8; maxlength: 18; required: lower, upper; required: digit; allowed: [#@$!%^&*(),~`.;:"\'?/];',
  'hotels.com':
    'minlength: 6; maxlength: 20; required: digit; required: [-~#@$%&!*_?^]; allowed: lower, upper;',
  'hotwire.com':
    'minlength: 6; maxlength: 30; allowed: lower, upper, digit, [-~!@#$%^&*_+=`|(){}[:;"\'<>,.?]];',
  'hrblock.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [$#%!];',
  'hsbc.com.hk':
    "minlength: 6; maxlength: 30; required: lower; required: upper; required: digit; allowed: ['.@_];",
  'hsbc.com.my':
    "minlength: 8; maxlength: 30; required: lower, upper; required: digit; allowed: [-!$*.=?@_'];",
  'hypovereinsbank.de':
    'minlength: 6; maxlength: 10; required: lower, upper, digit; allowed: [!"#$%&()*+:;<=>?@[{}~]];',
  'hyresbostader.se': 'minlength: 6; maxlength: 20; required: lower, upper; required: digit;',
  'ichunqiu.com': 'minlength: 8; maxlength: 20; required: lower; required: upper; required: digit;',
  'id.nfpa.org':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: [-"^#$%&\'()*+:=@[_|{}~]];',
  'id.sonyentertainmentnetwork.com':
    'minlength: 8; maxlength: 30; required: lower, upper; required: digit; allowed: [-!@#^&*=+;:];',
  'id.westfield.com':
    'minlength: 9; maxlength: 20; required: lower; required: upper; required: digit; required: [!"#&\'()*,./:;?@[\\^_`{|}~];',
  'identity.codesignal.com':
    'minlength: 14; required: digit; required: lower, upper; required: [!#$%&*@^]',
  'identitytheft.gov': 'allowed: lower, upper, digit, [!#%&*@^];',
  'idestination.info': 'maxlength: 15;',
  'impots.gouv.fr':
    "minlength: 12; maxlength: 128; required: lower; required: digit; allowed: [-!#$%&*+/=?^_'.{|}];",
  'indochino.com':
    'minlength: 6; maxlength: 15; required: upper; required: digit; allowed: lower, special;',
  'inntopia.travel': 'minlength: 7; maxlength: 19; required: digit; allowed: upper,lower,[-];',
  'internationalsos.com':
    'required: lower; required: upper; required: digit; required: [@#$%^&+=_];',
  'irctc.co.in':
    'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit; required: [!@#$%^&*()+];',
  'irs.gov':
    'minlength: 8; maxlength: 32; required: lower; required: upper; required: digit; required: [!#$%&*@];',
  'jal.co.jp': 'minlength: 8; maxlength: 16;',
  'japanpost.jp': 'minlength: 8; maxlength: 16; required: digit; required: upper,lower;',
  'jewelosco.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'jordancu-onlinebanking.org':
    'minlength: 6; maxlength: 32; allowed: upper, lower, digit,[-!"#$%&\'()*+,.:;<=>?@[^_`{|}~]];',
  'keldoc.com':
    'minlength: 12; required: lower; required: upper; required: digit; required: [!@#$%^&*];',
  'kennedy-center.org':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&*?@];',
  'key.harvard.edu':
    "minlength: 10; maxlength: 100; required: lower; required: upper; required: digit; allowed: [-@_#!&$`%*+()./,;~:{}|?>=<^[']];",
  'kfc.ca':
    'minlength: 6; maxlength: 15; required: lower; required: upper; required: digit; required: [!@#$%&?*];',
  'kiehls.com':
    'minlength: 8; maxlength: 25; required: lower; required: upper; required: digit; required: [!#$%&?@];',
  'kingsfoodmarkets.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'kiwibank.co.nz':
    'minlength: 6; maxlength: 15; required: digit; required: digit; required: upper,lower; required: upper,lower;',
  'klm.com': 'minlength: 8; maxlength: 12;',
  'kundenportal.edeka-smart.de':
    'minlength: 8; maxlength: 16; required: digit; required: upper, lower; required: [!"§$%&#];',
  'la-z-boy.com': 'minlength: 6; maxlength: 15; required: lower, upper; required: digit;',
  'labcorp.com':
    'minlength: 8; maxlength: 20; required: upper; required: lower; required: digit; required: [!@#$%^&*];',
  'ladwp.com': 'minlength: 8; maxlength: 20; required: digit; allowed: lower, upper;',
  'launtel.net.au': 'minlength: 8; required: digit; required: digit; allowed: lower, upper;',
  'leetchi.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&()*+,./:;<>?@"_];',
  'lepida.it':
    'minlength: 8; maxlength: 16; max-consecutive: 2; required: lower; required: upper; required: digit; required: [-!"#$%&\'()*+,.:;<=>?@[^_`{|}~]];',
  'lg.com':
    "minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; allowed: [-!#$%&'()*+,.:;=?@[^_{|}~]];",
  'linearity.io':
    'minlength: 8; required: lower; required: upper; required: digit; required: special;',
  'live.com':
    "minlength: 8; required: lower; required: upper; required: digit; allowed: [-@_#!&$`%*+()./,;~:{}|?>=<^'[]];",
  'lloydsbank.co.uk':
    'minlength: 8; maxlength: 15; required: lower; required: digit; allowed: upper;',
  'lowes.com':
    'minlength: 8; maxlength: 128; max-consecutive: 3; required: lower, upper; required: digit;',
  'loyalty.accor.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&=@];',
  'lsacsso.b2clogin.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit, [-!#$%&*?@^_];',
  'lufthansa.com':
    'minlength: 8; maxlength: 32; required: lower; required: upper; required: digit; required: [!#$%&()*+,./:;<>?@"_];',
  'lufthansagroup.careers':
    'minlength: 12; required: lower; required: upper; required: digit; required: [!#$%&*?@];',
  'macys.com':
    'minlength: 7; maxlength: 16; allowed: lower, upper, digit, [~!@#$%^&*+`(){}[:;"\'<>?]];',
  'mailbox.org':
    'minlength: 8; required: lower; required: upper; required: digit; allowed: [-!$"%&/()=*+#.,;:@?{}[]];',
  'makemytrip.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [@$!%*#?&];',
  'marriott.com':
    'minlength: 8; maxlength: 20; required: lower; required: upper; required: digit; allowed: [$!#&@?%=];',
  'maybank2u.com.my':
    'minlength: 8; maxlength: 12; max-consecutive: 2; required: lower; required: upper; required: digit; required: [-~!@#$%^&*_+=`|(){}[:;"\'<>,.?];',
  'medicare.gov':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: [@!$%^*()];',
  'meineschufa.de':
    'minlength: 10; required: lower; required: upper; required: digit; required: [!?#%$];',
  'member.everbridge.net':
    'minlength: 8; required: lower, upper; required: digit; allowed: [!@#$%^&*()];',
  'metlife.com': 'minlength: 6; maxlength: 20;',
  'microsoft.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: special;',
  'milogin.michigan.gov':
    'minlength: 8; required: lower; required: upper; required: digit; required: [@#$!~&];',
  'mintmobile.com':
    'minlength: 8; maxlength: 20; required: lower; required: upper; required: digit; required: special; allowed: [!#$%&()*+:;=@[^_`{}~]];',
  'mlb.com': 'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit;',
  'mountainwarehouse.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; allowed: [-@#$%^&*_+={}|\\:\',?/`~"();.];',
  'mpv.tickets.com':
    'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit;',
  'museumofflight.org': 'minlength: 8; maxlength: 15;',
  'my.konami.net':
    'minlength: 8; maxlength: 32; required: lower; required: upper; required: digit;',
  'myaccess.dmdc.osd.mil':
    "minlength: 9; maxlength: 20; required: lower; required: upper; required: digit; allowed: [-@_#!&$`%*+()./,;~:{}|?>=<^'[]];",
  'mybam.bcbsnm.com':
    'minlength: 8; maxlength: 64; max-consecutive: 2; required: lower; required: upper; required: digit; allowed: [!#$%&()*@[^{}~];',
  'mygoodtogo.com': 'minlength: 8; maxlength: 16; required: lower, upper, digit;',
  'myhealthrecord.com': 'minlength: 8; maxlength: 20; allowed: lower, upper, digit, [_.!$*=];',
  'mypatientvisit.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&*+.;?@^_~];',
  'mypay.dfas.mil':
    'minlength: 9; maxlength: 30; required: lower; required: upper; required: digit; required: [#@$%^!*+=_];',
  'mysavings.breadfinancial.com':
    'minlength: 8; maxlength: 25; required: lower; required: upper; required: digit; required: [+_%@!$*~];',
  'mysedgwick.com':
    'minlength: 8; maxlength: 16; allowed: lower; required: upper; required: digit; required: [@#$%^&+=!];',
  'mysmartmove.com':
    'minlength: 9; maxlength: 15; allowed: lower; required: upper; required: [!@#$%^&*()];',
  'mysubaru.com':
    'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit; allowed: [!#$%()*+,./:;=?@\\^`~];',
  'naver.com': 'minlength: 6; maxlength: 16;',
  'nekochat.cn': 'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit;',
  'nelnet.net':
    'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit, [!@#$&*];',
  'netflix.com': 'minlength: 4; maxlength: 60; required: lower, upper, digit; allowed: special;',
  'netgear.com': 'minlength: 6; maxlength: 128; allowed: lower, upper, digit, [!@#$%^&*()];',
  'networksolutions.com': 'minlength: 12; maxlength: 16;',
  'nicovideo.jp': 'minlength: 12; maxlength: 32;',
  'nowinstock.net': 'minlength: 6; maxlength: 20; allowed: lower, upper, digit;',
  'online.schoolsfirstfcu.org':
    "minlength: 8; maxlength: 20; required: lower; required: upper; required: digit; required: [-!#$%'()*+,/=?[^_`]];",
  'orange.fr':
    'minlength: 8; required: upper; required: lower; required: digit; allowed: [-,.;+:!?_];',
  'order.wendys.com':
    'minlength: 6; maxlength: 20; required: lower; required: upper; required: digit; allowed: [!#$%&()*+/=?^_{}];',
  'ototoy.jp': 'minlength: 8; allowed: upper,lower,digit,[- .=_];',
  'packageconciergeadmin.com': 'minlength: 4; maxlength: 4; allowed: digit;',
  'parksmarter.com':
    'minlength: 8; maxlength: 50; required: upper; required: digit; required: [!@#$%^&]; allowed: lower;',
  'patient.massciportal.com':
    'minlength: 12; required: upper; required: lower; required: digit; required: [!@#$%^&];',
  'pavilions.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'pay.citizensbank.com':
    'minlength: 8; maxlength: 24; required: lower; required: upper; required: digit; allowed: [!#$%&*@];',
  'paypal.com':
    'minlength: 8; maxlength: 20; max-consecutive: 3; required: lower, upper; required: digit, [!@#$%^&*()];',
  'payvgm.youraccountadvantage.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: special;',
  'pilotflyingj.com': 'minlength: 7; required: digit; allowed: lower, upper;',
  'pixnet.cc': 'minlength: 4; maxlength: 16; allowed: lower, upper;',
  'planetary.org':
    'minlength: 5; maxlength: 20; required: lower; required: upper; required: digit; allowed: ascii-printable;',
  'plazapremiumlounge.com':
    'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit; allowed: [!#$%&*,@^];',
  'portal.edd.ca.gov':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&()*@^];',
  'portals.emblemhealth.com':
    "minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&'()*+,./:;<>?@\\^_`{|}~[]];",
  'portlandgeneral.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; allowed: [!#$%&*?@];',
  'poste.it':
    'minlength: 8; maxlength: 16; max-consecutive: 2; required: lower; required: upper; required: digit; required: special;',
  'posteo.de':
    'minlength: 8; required: lower; required: upper; required: digit, [-~!#$%&_+=|(){}[:;"’<>,.? ]];',
  'powells.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: ["!@#$%^&*(){}[]];',
  'preferredhotels.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&()*+@^_];',
  'premier.ticketek.com.au': 'minlength: 6; maxlength: 16;',
  'premierinn.com': 'minlength: 8; required: upper; required: digit; allowed: lower;',
  'prepaid.bankofamerica.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: [!@#$%^&*()+~{}\'";:<>?];',
  'prestocard.ca':
    'minlength: 8; required: lower; required: upper; required: digit,[!"#$%&\'()*+,<>?@];',
  'pret.com':
    'minlength: 12; required: lower; required: digit; required: [@$!%*#?&]; allowed: upper;',
  'priceline.com':
    'required: upper; required: lower; required: digit; required: [!@#$%^&*()]; minlength: 12;',
  'promozoneapp.nmlottery.com':
    'minlength: 6; maxlength: 16; required: lower; required: upper; required: digit; allowed: special;',
  'propelfuels.com': 'minlength: 6; maxlength: 16;',
  'publix.com':
    'minlength: 8; maxlength: 28; required: upper; required: lower; allowed: digit,[!#$%*@^];',
  'qdosstatusreview.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&@^];',
  'qualtrics.com': 'minlength: 8; required: [!@#$%]; allowed: lower, upper, digit;',
  'questdiagnostics.com':
    'minlength: 8; maxlength: 30; required: upper, lower; required: digit, [!#$%&()*+<>?@^_~];',
  'randalls.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'realtor.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&*?@^];',
  'rejsekort.dk': 'minlength: 7; maxlength: 15; required: lower; required: upper; required: digit;',
  'renaud-bray.com': 'minlength: 8; maxlength: 38; allowed: upper,lower,digit;',
  'ring.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!@#$%^&*<>?];',
  'riteaid.com': 'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit;',
  'robinhood.com': 'minlength: 10;',
  'rogers.com': 'minlength: 8; required: lower, upper; required: digit; required: [!@#$];',
  'ruc.dk': 'minlength: 6; maxlength: 8; required: lower, upper; required: [-!#%&(){}*+;%/<=>?_];',
  'runescape.com':
    'minlength: 5; maxlength: 20; required: lower; required: upper; required: digit;',
  'ruten.com.tw': 'minlength: 6; maxlength: 15; required: lower, upper;',
  'safeway.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'salslimo.com':
    'minlength: 8; maxlength: 50; required: upper; required: lower; required: digit; required: [!@#$&*];',
  'santahelenasaude.com.br':
    'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit; required: [-!@#$%&*_+=<>];',
  'santander.de':
    "minlength: 8; maxlength: 12; required: lower, upper; required: digit; allowed: [-!#$%&'()*,.:;=?^{}];",
  'savemart.com':
    'minlength: 8; maxlength: 12; required: digit; required: upper,lower; required: [!#$%&@]; allowed: ascii-printable;',
  'sbisec.co.jp': 'minlength: 10; maxlength: 20; allowed: upper,lower,digit;',
  'screenscraper.fr': 'minlength: 6; maxlength: 25; allowed: upper,lower,digit;',
  'secure-arborfcu.org':
    "minlength: 8; maxlength: 15; required: lower; required: upper; required: digit; required: [!#$%&'()+,.:?@[_`~]];",
  'secure.orclinic.com':
    'minlength: 6; maxlength: 15; required: lower; required: digit; allowed: ascii-printable;',
  'secure.snnow.ca': 'minlength: 7; maxlength: 16; required: digit; allowed: lower, upper;',
  'sephora.com': 'minlength: 6; maxlength: 12;',
  'serviziconsolari.esteri.it':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: special;',
  'servizioelettriconazionale.it':
    'minlength: 8; maxlength: 20; required: lower; required: upper; required: digit; required: [!#$%&*?@^_~];',
  'sevasindhuservices.karnataka.gov.in':
    'minlength: 9; required: lower; required: upper; required: digit; required: [!@#$%^&*];',
  'sfwater.org':
    'minlength: 10; maxlength: 30; required: digit; allowed: lower, upper, [!@#$%*()_+^}{:;?.];',
  'shaws.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'signin.ea.com':
    'minlength: 8; maxlength: 64; required: lower, upper; required: digit; allowed: [-!@#^&*=+;:];',
  'sjwaterhub.com':
    'minlength: 8; maxlength: 30; required: digit, lower, upper; allowed: [!#%&*.];',
  'sony.com':
    'minlength: 8; maxlength: 30; max-consecutive: 2; required: lower, upper; required: digit; allowed: [-!@#^&*=+;:];',
  'southwest.com':
    'minlength: 8; maxlength: 16; required: upper; required: digit; allowed: lower, [!@#$%^*(),.;:/\\];',
  'speedway.com': 'minlength: 4; maxlength: 8; required: digit;',
  'spirit.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: [!@#$%^&*()];',
  'splunk.com':
    'minlength: 8; maxlength: 64; required: lower; required: upper; required: digit; required: [-!@#$%&*_+=<>];',
  'ssa.gov': 'required: lower; required: upper; required: digit; required: [~!@#$%^&*];',
  'starmarket.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'stayhealthy.at':
    'minlength: 8; maxlength: 32; max-consecutive: 6; required: lower; required: upper; required: digit;',
  'store.nintendo.co.uk': 'minlength: 8; maxlength: 20;',
  'store.nvidia.com':
    'minlength: 8; maxlength: 32; required: lower; required: upper; required: digit; required: [-!@#$%^*~:;&><[{}|_+=?]];',
  'store.steampowered.com':
    'minlength: 6; required: lower; required: upper; required: digit; allowed: [~!@#$%^&*];',
  'subscribe.free.fr':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: [!#&()*+/@[_]];',
  'successfactors.eu':
    'minlength: 8; maxlength: 18; required: lower; required: upper; required: digit,[-!"#$%&\'()*+,.:;<=>?@[^_`{|}~]];',
  'sulamericaseguros.com.br': 'minlength: 6; maxlength: 6;',
  'sunlife.com': 'minlength: 8; maxlength: 10; required: digit; required: lower, upper;',
  't-mobile.net': 'minlength: 8; maxlength: 16;',
  'target.com':
    'minlength: 8; maxlength: 20; required: lower, upper; required: digit, [-!"#$%&\'()*+,./:;=?@[\\^_`{|}~];',
  'tdscpc.gov.in':
    'minlength: 8; maxlength: 15; required: lower; required: upper; required: digit; required: [ &\',;"];',
  'telecharge.com':
    'minlength: 12; required: lower; required: upper; required: digit; required: [!#$%&*+=?@^];',
  'telekom-dienste.de':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: [#$%&()*+,./<=>?@_{|}~];',
  'thameswater.co.uk':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: special;',
  'themovingportal.co.uk':
    "minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; allowed: [-@#$%^&*_+={}|\\:',?/'~\" ();.[]];",
  'ticketweb.com': 'minlength: 12; maxlength: 15;',
  'tix.soundrink.com': 'minlength: 6; maxlength: 16;',
  'tomthumb.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'training.confluent.io':
    'minlength: 6; maxlength: 16; required: lower; required: upper; required: digit; allowed: [!#$%*@^_~];',
  'treasurer.mo.gov':
    'minlength: 8; maxlength: 26; required: lower; required: upper; required: digit; required: [!#$&];',
  'truist.com':
    'minlength: 8; maxlength: 28; max-consecutive: 2; required: lower; required: upper; required: digit; required: [!#$%()*,:;=@_];',
  'turkishairlines.com': 'minlength: 6; maxlength: 6; required: digit; max-consecutive: 3;',
  'twitch.tv': 'minlength: 8; maxlength: 71;',
  'twitter.com': 'minlength: 8;',
  'ubisoft.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: [-]; required: [!@#$%^&*()+];',
  'udel.edu':
    'minlength: 12; maxlength: 30; required: lower; required: upper; required: digit; required: [!@#$%^&*()+];',
  'umopass.com':
    'minlength: 8; required: upper; required: lower; required: digit; required: [!@#$%^];',
  'umterps.evenue.net':
    'minlength: 14; required: digit; required: upper; required: lower; required: [-~!@#$%^&*_+=`|(){}:;];',
  'unito.it':
    'minlength: 8; required: upper; required: lower; required: digit; required: [-!?+*/:;\'"{}()@£$%&=^#[]];',
  'user.ornl.gov':
    'minlength: 8; maxlength: 30; max-consecutive: 3; required: lower, upper; required: digit; allowed: [!#$%./_];',
  'usps.com':
    'minlength: 8; maxlength: 50; max-consecutive: 2; required: lower; required: upper; required: digit; allowed: [-!"#&\'()+,./?@];',
  'vagaro.com':
    'minlength: 9; required: lower; required: upper; required: digit; required: [@$!%*?&];',
  'vanguard.com':
    'minlength: 8; maxlength: 20; required: lower; required: upper; required: digit; required: digit; required: special;',
  'vanguardinvestor.co.uk':
    'minlength: 8; maxlength: 50; required: lower; required: upper; required: digit; required: digit;',
  'venmo.com':
    'minlength: 8; maxlength: 20; max-consecutive: 3; required: lower; required: upper; required: digit; required: [~!@#$%^&*()+=];',
  'ventrachicago.com': 'minlength: 8; required: lower; required: upper; required: digit, [!@#$%^];',
  'verizonwireless.com':
    'minlength: 8; maxlength: 20; required: lower, upper; required: digit; allowed: unicode;',
  'vetsfirstchoice.com':
    'minlength: 8; required: lower; required: upper; required: digit; allowed: [?!@$%^+=&];',
  'vince.com':
    'minlength: 8; required: digit; required: lower; required: upper; required: [$%/(){}=?!.,_*|+~#[]];',
  'virginmobile.ca':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!#$@];',
  'visa.com': 'minlength: 6; maxlength: 32;',
  'visabenefits-auth.axa-assistance.us':
    'minlength: 8; required: lower; required: upper; required: digit; required: [!"#$%&()*,.:<>?@^{|}];',
  'vivo.com.br': 'maxlength: 6; max-consecutive: 3; allowed: digit;',
  'volaris.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; required: special;',
  'vons.com':
    'minlength: 8; maxlength: 40; required: upper; required: [!#$%&*@^]; allowed: lower,digit;',
  'wa.aaa.com':
    'minlength: 8; maxlength: 16; required: lower; required: upper; required: digit; allowed: ascii-printable;',
  'walgreens.com': 'minlength: 8; required: lower; required: digit; allowed: [!#$%&*@^]',
  'walkhighlands.co.uk':
    'minlength: 9; maxlength: 15; required: lower; required: upper; required: digit; allowed: special;',
  'walmart.com': 'allowed: lower, upper, digit, [-(~!@#$%^&*_+=`|(){}[:;"\'<>,.?]];',
  'waze.com':
    'minlength: 8; maxlength: 64; required: lower; required: upper; required: special; required: digit;',
  'wccls.org': 'minlength: 4; maxlength: 16; allowed: lower, upper, digit;',
  'web.de':
    'minlength: 8; maxlength: 40; allowed: lower, upper, digit, [-<=>~!|()@#{}$%,.?^\'&*_+`:;"[]];',
  'websale.cinestar.cz':
    'minlength: 8; maxlength: 16; required: lower; required: digit; allowed: upper, [-!@#$%&*_+=<>];',
  'wegmans.com': 'minlength: 8; required: digit; required: upper,lower; required: [!#$%&*+=?@^];',
  'weibo.com': 'minlength: 6; maxlength: 16;',
  'wellsfargo.com':
    'minlength: 8; maxlength: 32; required: lower; required: upper; required: digit;',
  'wmata.com':
    'minlength: 8; required: lower, upper; required: digit; required: digit; required: [-!@#$%^&*~/"()_=+\\|,.?[]];',
  'worldstrides.com':
    'minlength: 8; required: lower; required: upper; required: digit; required: [-!#$%&*+=?@^_~];',
  'wsj.com':
    'minlength: 5; maxlength: 15; required: digit; allowed: lower, upper, [-~!@#$^*_=`|(){}[:;"\'<>,.?]];',
  'xfinity.com': 'minlength: 8; maxlength: 16; required: lower, upper; required: digit;',
  'xiaomi.com': 'minlength: 8; maxlength: 16; required: upper,lower; required: digit,special;',
  'xvoucher.com': 'minlength: 11; required: upper; required: digit; required: [!@#$%&_];',
  'yatra.com':
    "minlength: 8; required: lower; required: upper; required: digit; required: [!#$%&'()+,.:?@[_`~]];",
  'yeti.com': 'minlength: 8; required: lower; required: upper; required: digit; required: [#$%*];',
  'zara.com': 'minlength: 8; required: lower; required: upper; required: digit;',
  'zdf.de': 'minlength: 8; required: upper; required: digit; allowed: lower, special;',
  'zoom.us':
    'minlength: 8; maxlength: 32; max-consecutive: 3; required: lower; required: upper; required: digit;'
}
