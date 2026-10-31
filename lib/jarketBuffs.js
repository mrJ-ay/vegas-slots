/* =========================================================
   JARKET (자켓마트) 아이템 연동 슬롯 버프 엔진
   - 보유한 모든 아이템 및 수량(Quantity)이 100% 동시 중첩 적용!
   - 배율 동시 합산, 스핀당 칩 동시 누적, 꽝 환급 보험 동시 중첩, 매머드 부활 중첩
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

    let addMultiplier = 0; // 기본 1.0에 각 아이템별 보너스 배율 합산
    let flatBonus = 0;     // 스핀당 칩 누적 합산
    let lossShieldRate = 0;// 꽝 환급 보험율 합산 (최대 100%)
    let cherryBonus = 0;   // 체리 배율 합산
    let resurrectionAmount = 0; // 파산 부활 충전액
    const activeBuffs = [];

    for (const item of rows) {
      const id = item.item_id;
      const qty = Math.max(1, item.quantity || 1);
      const buffsDescList = [];

      // 1. 당첨금 배율 동시 중첩 (+배율 * 수량)
      let itemMultBonus = 0;
      if (id === 'flex_mars_ship') itemMultBonus = 9.0;       // 기본 1.0 + 9.0 = 10배
      else if (id === 'flex_island') itemMultBonus = 4.0;     // 기본 1.0 + 4.0 = 5배
      else if (id === 'mammoth_tbone') {
        itemMultBonus = 2.5;
        resurrectionAmount += 5000 * qty;
        buffsDescList.push(`파산 시 $${(5000 * qty).toLocaleString()} 부활`);
      }
      else if (id === 'flex_gold_cart') itemMultBonus = 2.0;  // 3배 (+2.0)
      else if (id === 'nm_gold_cookie') itemMultBonus = 1.5;  // 2.5배 (+1.5)
      else if (id === 'hanwoo_1plus') itemMultBonus = 1.0;    // 2.0배 (+1.0)
      else if (id === 'jarket_pizza') itemMultBonus = 0.5;    // 1.5배 (+0.5)
      else if (id === 'dangdang_chicken') itemMultBonus = 0.3;// 1.3배 (+0.3)
      else if (id === 'shine_muscat') itemMultBonus = 0.2;    // 1.2배 (+0.2)

      if (itemMultBonus > 0) {
        addMultiplier += itemMultBonus * qty;
        buffsDescList.push(`당첨금 +${(itemMultBonus * qty).toFixed(1)}배 추가`);
      }

      // 2. 스핀할 때마다 고정 추가 칩 동시 누적 (칩 * 수량)
      let itemChip = 0;
      if (id === 'gaming_fridge') itemChip = 50;
      else if (id === 'real_slot_machine') {
        itemChip = 30;
        lossShieldRate += 0.7 * qty;
        buffsDescList.push(`꽝 ${Math.round(0.7 * qty * 100)}% 환급`);
      }
      else if (id === 'mega_sushi') itemChip = 20;
      else if (id === 'pork_belly') itemChip = 10;
      else if (id === 'nm_cookie_tub') itemChip = 5;
      else if (id === 'nm_water') itemChip = 2;
      else if (String(id).startsWith('user_')) itemChip = 1;

      if (itemChip > 0) {
        flatBonus += itemChip * qty;
        buffsDescList.push(`스핀마다 +$${itemChip * qty} 칩`);
      }

      // 3. 꽝 / 연패 환급 안심 보험 동시 누적
      if (id === 'aurora_salmon') {
        lossShieldRate += 0.5 * qty;
        buffsDescList.push(`꽝 ${Math.round(0.5 * qty * 100)}% 환급`);
      } else if (id === 'nm_tissue') {
        lossShieldRate += 0.3 * qty;
        buffsDescList.push(`꽝 ${Math.round(0.3 * qty * 100)}% 환급`);
      }

      // 4. 체리 심볼 증폭
      if (id === 'tv_200inch') {
        cherryBonus += 2.0 * qty;
        buffsDescList.push(`체리 당첨 +${(2.0 * qty).toFixed(1)}배`);
      }

      activeBuffs.push({
        id,
        name: item.name,
        icon: item.icon,
        quantity: qty,
        desc: buffsDescList.join(' · ') || '자켓마트 슬롯 서포트'
      });
    }

    const finalMultiplier = Number((1.0 + addMultiplier).toFixed(2));
    const finalLossShieldRate = Math.min(1.0, Number(lossShieldRate.toFixed(2))); // 최대 100% 환급
    const finalCherryMultiplier = Number((1.0 + cherryBonus).toFixed(2));

    return {
      multiplier: finalMultiplier,
      flatBonus,
      lossShieldRate: finalLossShieldRate,
      cherryMultiplier: finalCherryMultiplier,
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
