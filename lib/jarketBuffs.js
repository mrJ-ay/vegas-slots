/* =========================================================
   JARKET (자켓마트) 아이템 연동 슬롯 버프 엔진
   - 유저가 자켓마트에서 구매해 보유 중인 아이템에 따라
     슬롯머신 스핀 시 당첨 배율(x1.2~x10), 스핀당 추가 칩(+$2~$50),
     연패 꽝 환급 보험(30%~70%), 파산 부활 실드 등을 자동 계산
   ========================================================= */

export async function getJarketBuffs(client, userId) {
  try {
    const { rows } = await client.query(
      `SELECT item_id, quantity, name, icon FROM jk_inventory WHERE user_id = $1 AND quantity > 0`,
      [userId]
    );

    if (!rows || !rows.length) {
      return {
        multiplier: 1.0,
        flatBonus: 0,
        lossShieldRate: 0,
        cherryMultiplier: 1.0,
        resurrectionAmount: 0,
        activeBuffs: []
      };
    }

    let multiplier = 1.0;
    let flatBonus = 0;
    let lossShieldRate = 0;
    let cherryMultiplier = 1.0;
    let resurrectionAmount = 0;
    const activeBuffs = [];

    for (const item of rows) {
      const id = item.item_id;
      let buffDesc = '';

      // 1. 당첨금 배율 증폭 (보유 아이템 중 최고 배율 적용)
      if (id === 'flex_mars_ship') {
        multiplier = Math.max(multiplier, 10.0);
        buffDesc = '당첨금 10배 폭발 (x10.0)';
      } else if (id === 'flex_island') {
        multiplier = Math.max(multiplier, 5.0);
        buffDesc = '당첨금 5배 증폭 (x5.0)';
      } else if (id === 'mammoth_tbone') {
        multiplier = Math.max(multiplier, 3.5);
        resurrectionAmount = Math.max(resurrectionAmount, 5000);
        buffDesc = '당첨금 3.5배 & 파산 시 $5,000 부활';
      } else if (id === 'flex_gold_cart') {
        multiplier = Math.max(multiplier, 3.0);
        buffDesc = '당첨금 3배 증폭 (x3.0)';
      } else if (id === 'nm_gold_cookie') {
        multiplier = Math.max(multiplier, 2.5);
        buffDesc = '당첨금 2.5배 증폭 (x2.5)';
      } else if (id === 'hanwoo_1plus') {
        multiplier = Math.max(multiplier, 2.0);
        buffDesc = '당첨금 2배 증폭 (x2.0)';
      } else if (id === 'jarket_pizza') {
        multiplier = Math.max(multiplier, 1.5);
        buffDesc = '당첨금 1.5배 증폭 (x1.5)';
      } else if (id === 'dangdang_chicken') {
        multiplier = Math.max(multiplier, 1.3);
        buffDesc = '당첨금 1.3배 증폭 (x1.3)';
      } else if (id === 'shine_muscat') {
        multiplier = Math.max(multiplier, 1.2);
        buffDesc = '당첨금 1.2배 증폭 (x1.2)';
      }

      // 2. 스핀할 때마다 고정 추가 칩 지급 (합산 누적)
      if (id === 'gaming_fridge') {
        flatBonus += 50;
        buffDesc = (buffDesc ? buffDesc + ' · ' : '') + '스핀마다 +$50 칩';
      } else if (id === 'real_slot_machine') {
        flatBonus += 30;
        lossShieldRate = Math.max(lossShieldRate, 0.7);
        buffDesc = (buffDesc ? buffDesc + ' · ' : '') + '스핀마다 +$30 칩 & 꽝 70% 환급';
      } else if (id === 'mega_sushi') {
        flatBonus += 20;
        buffDesc = (buffDesc ? buffDesc + ' · ' : '') + '스핀마다 +$20 칩';
      } else if (id === 'pork_belly') {
        flatBonus += 10;
        buffDesc = (buffDesc ? buffDesc + ' · ' : '') + '스핀마다 +$10 칩';
      } else if (id === 'nm_cookie_tub') {
        flatBonus += 5;
        buffDesc = (buffDesc ? buffDesc + ' · ' : '') + '스핀마다 +$5 칩';
      } else if (id === 'nm_water') {
        flatBonus += 2;
        buffDesc = (buffDesc ? buffDesc + ' · ' : '') + '스핀마다 +$2 칩';
      } else if (String(id).startsWith('user_')) {
        flatBonus += 1;
        buffDesc = (buffDesc ? buffDesc + ' · ' : '') + '스핀마다 +$1 칩';
      }

      // 3. 꽝 / 연패 환급 안심 보험 (보유 아이템 중 최고 환급율 적용)
      if (id === 'aurora_salmon') {
        lossShieldRate = Math.max(lossShieldRate, 0.5);
        buffDesc = (buffDesc ? buffDesc + ' · ' : '') + '꽝 50% 환급 보험';
      } else if (id === 'nm_tissue') {
        lossShieldRate = Math.max(lossShieldRate, 0.3);
        buffDesc = (buffDesc ? buffDesc + ' · ' : '') + '꽝 30% 환급 보험';
      }

      // 4. 체리 심볼 증폭
      if (id === 'tv_200inch') {
        cherryMultiplier = Math.max(cherryMultiplier, 3.0);
        buffDesc = (buffDesc ? buffDesc + ' · ' : '') + '체리(🍒) 당첨 3배';
      }

      activeBuffs.push({
        id,
        name: item.name,
        icon: item.icon,
        quantity: item.quantity,
        desc: buffDesc || '자켓마트 슬롯 서포트'
      });
    }

    return {
      multiplier,
      flatBonus,
      lossShieldRate,
      cherryMultiplier,
      resurrectionAmount,
      activeBuffs
    };
  } catch (err) {
    console.warn('[Jarket Buffs Error]', err.message);
    return {
      multiplier: 1.0,
      flatBonus: 0,
      lossShieldRate: 0,
      cherryMultiplier: 1.0,
      resurrectionAmount: 0,
      activeBuffs: []
    };
  }
}
