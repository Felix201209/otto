/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

const PARKING_APPLICATION_PRICES: Record<string, {
  label: string;
  amount: number;
  billingUnit: string;
}> = {
  'underground-fixed': { label: '地下固定停车位', amount: 260, billingUnit: '月' },
  '地下固定停车位:260元/月': { label: '地下固定停车位', amount: 260, billingUnit: '月' },
  'underground-tandem': { label: '地下固定子母停车位', amount: 390, billingUnit: '月' },
  '地下固定子母停车位:390元/月': { label: '地下固定子母停车位', amount: 390, billingUnit: '月' },
  'surface-temporary': { label: '地上临时停车位', amount: 1200, billingUnit: '半年' },
  '地上临时停车位:1200元/半年': { label: '地上临时停车位', amount: 1200, billingUnit: '半年' },
  'underground-temporary': { label: '地下临时停车位', amount: 1560, billingUnit: '半年' },
  '地下临时停车位:1560元/半年': { label: '地下临时停车位', amount: 1560, billingUnit: '半年' },
  cancel: { label: '退停车位', amount: 0, billingUnit: '次' },
  '退停车位': { label: '退停车位', amount: 0, billingUnit: '次' },
};

const NETWORK_PHONE_PRICES: Record<string, {
  label: string;
  amount: number;
  recurringMonthly: number;
}> = {
  'phone-open': { label: '开通电话（开通费235元/部，线路占用费35元/月/部）', amount: 270, recurringMonthly: 35 },
  '开通电话': { label: '开通电话（开通费235元/部，线路占用费35元/月/部）', amount: 270, recurringMonthly: 35 },
  'caller-id': { label: '来电显示（开通费50元/部，功能费5元/月/部）', amount: 55, recurringMonthly: 5 },
  '来电显示': { label: '来电显示（开通费50元/部，功能费5元/月/部）', amount: 55, recurringMonthly: 5 },
  'number-hold': { label: '停机保号（5元/月/部）', amount: 5, recurringMonthly: 5 },
  '停机保号': { label: '停机保号（5元/月/部）', amount: 5, recurringMonthly: 5 },
  'landline-stop': { label: '固话停机', amount: 0, recurringMonthly: 0 },
  '固话停机': { label: '固话停机', amount: 0, recurringMonthly: 0 },
  'leased-line-15': { label: '企业专线 15M（500元/月）', amount: 500, recurringMonthly: 500 },
  'leased-line-30': { label: '企业专线 30M（1000元/月）', amount: 1000, recurringMonthly: 1000 },
  'leased-line-45': { label: '企业专线 45M（1600元/月）', amount: 1600, recurringMonthly: 1600 },
  'leased-line-75': { label: '企业专线 75M（2900元/月）', amount: 2900, recurringMonthly: 2900 },
};

function requiredParkFormValue(
  formData: Record<string, string>,
  key: string,
  label: string,
): string {
  const value = formData[key]?.trim() || '';
  if (!value) throw new Error(`请填写${label}`);
  return value;
}

function parkFormPositiveInteger(
  value: string,
  label: string,
  allowZero = false,
): number {
  const number = Number(value);
  if (
    !Number.isInteger(number)
    || number < (allowZero ? 0 : 1)
    || number > 1000
  ) {
    throw new Error(
      `${label}必须是${allowZero ? '大于等于 0' : '大于等于 1'}的整数`,
    );
  }
  return number;
}

function parkFormMoney(value: string, label: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
    throw new Error(`${label}必须是有效金额`);
  }
  return Math.round(amount * 100) / 100;
}

function parkFormPositiveDecimal(value: string, label: string): number {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
    throw new Error(`${label}必须是大于 0 的有效数字`);
  }
  return Math.round(quantity * 100) / 100;
}

function validParkDate(value: string, label: string): string {
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`请选择有效的${label}`);
  }
  return date;
}

function validParkTime(value: string, label: string): string {
  const time = value.trim();
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (
    !match
    || Number(match[1]) > 23
    || Number(match[2]) > 59
  ) {
    throw new Error(`请选择有效的${label}`);
  }
  return time;
}

function assertMeetingPeriod(startValue: string, endValue: string): {
  startTime: string;
  endTime: string;
  startMinutes: number;
  endMinutes: number;
} {
  const parse = (value: string): number => {
    const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
    if (!match) return Number.NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const startMinutes = parse(startValue);
  const endMinutes = parse(endValue);
  if (
    !Number.isInteger(startMinutes)
    || !Number.isInteger(endMinutes)
    || startMinutes < 9 * 60
    || endMinutes > 23 * 60
    || startMinutes >= endMinutes
    || startMinutes % 10 !== 0
    || endMinutes % 10 !== 0
  ) {
    throw new Error('会议时间必须在 09:00 到 23:00 之间，并按 10 分钟选择');
  }
  const format = (minutes: number): string => (
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  );
  return {
    startTime: format(startMinutes),
    endTime: format(endMinutes),
    startMinutes,
    endMinutes,
  };
}

export function normalizeParkServiceFormData(
  serviceId: string,
  input: Record<string, string>,
): Record<string, string> {
  const formData = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key.slice(0, 50),
      value.trim().slice(0, 2000),
    ]),
  );
  for (const [key, label] of [
    ['company', '公司名称'],
    ['roomNumber', '房间号'],
    ['contact', '联系人'],
    ['phone', '联系电话'],
  ] as const) {
    formData[key] = requiredParkFormValue(formData, key, label);
  }

  if (serviceId === 'renovation') {
    formData.area = requiredParkFormValue(formData, 'area', '装修区域');
    formData.startDate = validParkDate(
      requiredParkFormValue(formData, 'startDate', '计划开工日期'),
      '计划开工日期',
    );
  } else if (serviceId === 'parking') {
    const application = PARKING_APPLICATION_PRICES[
      requiredParkFormValue(formData, 'applicationType', '申请内容')
    ];
    if (!application) throw new Error('请选择有效的停车办理申请内容');
    const quantity = parkFormPositiveInteger(
      requiredParkFormValue(formData, 'quantity', '申请数量'),
      '申请数量',
    );
    formData.applicationType = application.label;
    formData.pricing = `${application.amount}元/${application.billingUnit}`;
    formData.billingUnit = application.billingUnit;
    const amountCny = application.amount * quantity;
    formData.amountCny = String(amountCny);
    formData.recurringMonthlyCny = String(
      application.billingUnit === '月'
        ? amountCny
        : application.billingUnit === '半年'
          ? Math.round((amountCny / 6) * 100) / 100
          : 0,
    );
  } else if (serviceId === 'network-phone') {
    const business = NETWORK_PHONE_PRICES[
      requiredParkFormValue(formData, 'businessType', '业务类型')
    ];
    if (!business) throw new Error('请选择有效的网络或电话业务类型');
    const quantity = parkFormPositiveInteger(
      requiredParkFormValue(formData, 'quantity', '工位或号码数量'),
      '工位或号码数量',
    );
    formData.businessType = business.label;
    formData.expectedDate = validParkDate(
      requiredParkFormValue(formData, 'expectedDate', '期望开通日期'),
      '期望开通日期',
    );
    formData.amountCny = String(business.amount * quantity);
    formData.recurringMonthlyCny = String(business.recurringMonthly * quantity);
  } else if (serviceId === 'meeting-room') {
    parkFormPositiveInteger(
      requiredParkFormValue(formData, 'attendees', '参会人数'),
      '参会人数',
    );
    formData.roomId = requiredParkFormValue(formData, 'roomId', '会议室');
    formData.date = validParkDate(
      requiredParkFormValue(formData, 'date', '使用日期'),
      '使用日期',
    );
    formData.meetingContent = requiredParkFormValue(
      formData,
      'meetingContent',
      '会议内容',
    );
    const period = assertMeetingPeriod(
      requiredParkFormValue(formData, 'startTime', '开始时间'),
      requiredParkFormValue(formData, 'endTime', '结束时间'),
    );
    const priceHalfDay = parkFormMoney(
      requiredParkFormValue(formData, 'priceHalfDay', '会议室价格'),
      '会议室价格',
    );
    const halfDayUnits = Math.ceil(
      (period.endMinutes - period.startMinutes) / (4 * 60),
    );
    formData.startTime = period.startTime;
    formData.endTime = period.endTime;
    formData.time = `${period.startTime}-${period.endTime}`;
    formData.amountCny = String(priceHalfDay * halfDayUnits);
    formData.pricing = `${priceHalfDay}元/半天，不足半天按半天计`;
  } else if (serviceId === 'electric-card') {
    const hasChargingKwh = Boolean(formData.chargingKwh?.trim());
    const legacyAmountCny = hasChargingKwh
      ? null
      : parkFormMoney(
          requiredParkFormValue(formData, 'amount', '充电金额'),
          '充电金额',
        );
    const chargingKwh = hasChargingKwh
      ? parkFormPositiveDecimal(formData.chargingKwh!, '充电度数')
      : Math.round((legacyAmountCny! / 1.2) * 100) / 100;
    delete formData.amount;
    formData.chargingKwh = String(chargingKwh);
    formData.unitPriceCny = '1.2';
    formData.pricing = '1.2元/度';
    formData.amountCny = String(
      legacyAmountCny ?? Math.round(chargingKwh * 120) / 100,
    );
  } else if (serviceId === 'repair') {
    formData.category = requiredParkFormValue(formData, 'category', '报修类别');
    formData.issue = requiredParkFormValue(formData, 'issue', '故障描述');
    formData.urgency = requiredParkFormValue(formData, 'urgency', '紧急程度');
  } else if (serviceId === 'vehicle-visit') {
    formData.visitDate = validParkDate(
      requiredParkFormValue(formData, 'visitDate', '来访日期'),
      '来访日期',
    );
    formData.visitTime = validParkTime(
      requiredParkFormValue(formData, 'visitTime', '来访时间'),
      '来访时间',
    );
    formData.reason = requiredParkFormValue(
      formData,
      'reason',
      '拜访企业及事由',
    );
    const vehicleCount = parkFormPositiveInteger(
      requiredParkFormValue(formData, 'vehicleCount', '来访车辆数量'),
      '来访车辆数量',
      true,
    );
    if (vehicleCount > 20) throw new Error('来访车辆数量不能超过 20');
    for (let index = 1; index <= vehicleCount; index += 1) {
      formData[`plate${index}`] = requiredParkFormValue(
        formData,
        `plate${index}`,
        `第 ${index} 辆车车牌号`,
      );
    }
  }
  return formData;
}
